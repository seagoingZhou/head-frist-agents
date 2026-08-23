import type { 
    AgentMessage, 
    AgentContext, 
    AgentLoopConfig,
    AgentToolCall,
    StreamFn,
    AgentEvent,
    AgentTool,
    AgentToolResult
} from "./types";
import  {
    type AssistantMessage,
    EventStream,
    streamSimple,
    ToolResult,
    ToolResultMessage,
    text,
    ToolCall,
    validateToolArguments,
} from "pi-ai";

type PreparedToolCall = {
	kind: "prepared";
	toolCall: ToolCall;
	tool: AgentTool;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}




export function agentLoop(
    prompts: AgentMessage[],
    context: AgentContext,
    config: AgentLoopConfig,
    signal?: AbortSignal,
    streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
    const eventStream = createAgentStream();

    (async () => {
        const newMessages: AgentMessage[] = [...prompts];
        const currentContext: AgentContext = {
            ...context,
            messages: [...context.messages, ...prompts],
        };
        eventStream.push({type:"agent_start"})
        eventStream.push({type:"turn_start"})
        for (const prompt of prompts){
            eventStream.push({type:"message_start", message:prompt})
            eventStream.push({type:"message_end", message:prompt})
        }


        await runLoop(currentContext, newMessages, config, signal, eventStream, streamFn)
    })();

    return eventStream;

}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
    return new EventStream<AgentEvent, AgentMessage[]>(
        (event:AgentEvent) => event.type === "agent_end",
        (event:AgentEvent) => (event.type === "agent_end" ? event.messages : [])
            
    );
}



// 主循环 AgentLoop

async function runLoop(
    currentAgentContext: AgentContext,
    newMessages: AgentMessage[],
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
    stream: EventStream<AgentEvent, AgentMessage[]>,
    streamFn?: StreamFn
) : Promise<void> {

    let hasMoreToolCalls = true;
    let firstTurn = true;
    let queuedMessages : AgentMessage[] = (await config.getQueuedMessages?.()) || [];

    while(hasMoreToolCalls || queuedMessages.length > 0) {
        if (!firstTurn){
            stream.push({type:"turn_start"});
        } else{
            firstTurn = false;
        }

        // 在每轮循环里、生成LLM助手回复前，把 queuedMessages 里的消息先排队注入上下文
        if (queuedMessages.length > 0){
            for (const message of queuedMessages){
                stream.push({type:"message_start",message});
                stream.push({type:"message_end",message});
                currentAgentContext.messages.push(message);
                newMessages.push(message);
            }
            queuedMessages = [];
        }
        

        // LLM助手 流式回复
        const assistantMessage = await streamAssistantResponse(
            currentAgentContext,
            config,
            signal,
            stream,
            streamFn
        )
        newMessages.push(assistantMessage)

        // 
        if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted"){
            stream.push({type:"turn_end", message:assistantMessage, toolResults:[]})
            stream.push({type:"agent_end",messages:newMessages})
            stream.end(newMessages)
            return
        }

        const toolCalls = assistantMessage.content
                                            .filter(
                                                (c) =>
                                                    c.type === "toolCall"
                                            );

        const toolResults : ToolResultMessage[] = [];
        hasMoreToolCalls = false;
        if (toolCalls.length > 0) {
             const executedToolBatch = await excuteToolCalls(
                currentAgentContext,
                assistantMessage,
                config,
                signal,
                stream
            )
            toolResults.push(...executedToolBatch.messages);
            hasMoreToolCalls = !executedToolBatch.terminate;

            for (const result of toolResults) {
                currentAgentContext.messages.push(result);
                newMessages.push(result);
            }
        }

        stream.push(
            {
                type : "turn_end",
                message : assistantMessage,
                toolResults
            }
        )

        queuedMessages = (await config.getQueuedMessages?.()) || [];

    }
    stream.push(
        {
            type : "agent_end",
            messages : newMessages
        }
    );

    stream.end(newMessages);

}



function prepareToolCallArguments(
    tool: AgentTool,
    toolCall: AgentToolCall,
): AgentToolCall {

    if (!tool.prepareArguments) {
        return toolCall;
    }

    const preparedArguments = tool.prepareArguments(toolCall.arguments);
    if (preparedArguments === toolCall.arguments) {
        return toolCall;
    }

    return {
        ...toolCall,
        arguments: preparedArguments as Record<string, unknown>
    }
}

async function prepareToolCall(
    currentAgentContext: AgentContext,
    assistantMessage: AssistantMessage,
    toolCall: ToolCall,
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
    const tool = currentAgentContext.tools?.find(
        (t) =>
            t.name === toolCall.name
    );
    if (!tool) {
        return {
            kind: "immediate",
            result: createErrorToolResult(`Tool ${toolCall.name} not found`),
            isError: true,
        }
    }

   try {
        const preparedToolCall = prepareToolCallArguments(tool, toolCall);
        const validatedArgs = validateToolArguments(tool, preparedToolCall);

        if (config.beforeToolCall) {
            const beforeResult = await config.beforeToolCall(
                {
                    assistantMessage,
                    toolCall,
                    args: validatedArgs,
                    context: currentAgentContext
                },
                signal, 
            );
            if (signal?.aborted) {
                return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
            }
            if (beforeResult?.block) {
                return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
            }
        }

        if (signal?.aborted) {
            return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
        }

        return {
            kind: "prepared",
            toolCall,
            tool,
            args: validatedArgs,
        }

   } catch (error) {
        return {
            kind: "immediate",
            result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
            isError: true,
        };
   }
}

async function finalizeExecutedToolCall(
    currentContext: AgentContext,
    assistantMessage: AssistantMessage,
    prepared: PreparedToolCall,
    executed: ExecutedToolCallOutcome,
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
    let result = executed.result;
    let isError = executed.isError;

    if (config.afterToolCall) {
        try {
            const afterResult = await config.afterToolCall(
                {
                    assistantMessage,
                    toolCall: prepared.toolCall,
                    args: prepared.args,
                    result,
                    isError,
                    context: currentContext,
                },
                signal
            );
            if (afterResult) {
                result = {
                    content: afterResult.content ?? result.content,
                    details: afterResult.details ?? result.details,
                    terminate: afterResult.terminate ?? result.terminate
                };
                isError = afterResult.isError ?? isError;
            }
        } catch (error) {
            result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true; 
        }
    }

    return {
        toolCall: prepared.toolCall,
        result,
        isError
    };
}

async function executePreparedToolCall(
    prepared: PreparedToolCall,
    signal: AbortSignal | undefined,
    stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<ExecutedToolCallOutcome> {
    const updateEvents: Promise<void>[] = [];
    let acceptingUpdates = true;
    
    try {
        const result = await prepared.tool.execute(
            prepared.toolCall.id,
            prepared.args as never,
            signal,
            (partialResult) => {
                if (!acceptingUpdates) {
                    return;
                }
                updateEvents.push(
                    Promise.resolve(
                        stream.push(
                            {
                                type: "tool_execution_update",
                                toolCallId: prepared.toolCall.id,
                                toolName: prepared.toolCall.name,
                                args: prepared.toolCall.arguments,
                                partialResult,
                            }
                        )
                    )
                )
            }
        );
        acceptingUpdates = false;
        await Promise.all(updateEvents);
        return {
            result,
            isError: false
        };
    } catch (error) {
        acceptingUpdates = false;
        await Promise.all(updateEvents);
        return {
            result: createErrorToolResult(error instanceof Error? error.message: String(error)),
            isError: true,
        }
    } finally {
        acceptingUpdates = false;
    }
}


type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
    currentContext: AgentContext,
    assistantMessage: AssistantMessage,
    toolCalls: AgentToolCall[],
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
    stream : EventStream<AgentEvent, AgentMessage[]>,
): Promise<ExecutedToolCallBatch> {
    const finalizedCalls: FinalizedToolCallOutcome[] = [];
    const messages: ToolResultMessage[] = [];

    for (const toolCall of toolCalls) {
        stream.push(
            {
                type: "tool_execution_start",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                args: toolCall.arguments,
            }
        );

        const preparation = await prepareToolCall(
            currentContext,
            assistantMessage,
            toolCall,
            config,
            signal
        );
        let finalized: FinalizedToolCallOutcome;
        if (preparation.kind === "immediate") {
            finalized = {
                toolCall,
                result: preparation.result,
                isError: preparation.isError,
            };
        } else {
            const executed = await executePreparedToolCall(preparation, signal, stream);
            finalized = await finalizeExecutedToolCall(
                currentContext,
                assistantMessage,
                preparation,
                executed,
                config,
                signal
            )
        }

        emitToolExecutionEnd(finalized, stream);

        const toolResultMessage = createToolResultMessage(finalized);

        emitToolResultMessage(toolResultMessage, stream);

        
        finalizedCalls.push(finalized);
        messages.push(toolResultMessage);

        if (signal?.aborted) {
            break;
        }

    }

    return {
        messages,
        terminate: shouldTerminateToolBatch(finalizedCalls),
    };
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream : EventStream<AgentEvent, AgentMessage[]>,
): Promise<ExecutedToolCallBatch> {
    const finalizedCalls: FinalizedToolCallEntry[] = [];

    for (const toolCall of toolCalls) {
        stream.push(
            {
                type: "tool_execution_start",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                args: toolCall.arguments,
            }
        );

        const preparation = await prepareToolCall(
            currentContext,
            assistantMessage,
            toolCall,
            config,
            signal
        );

        if (preparation.kind === "immediate") {
            const finalized = {
                toolCall,
                result: preparation.result,
                isError: preparation.isError,
            } satisfies FinalizedToolCallOutcome;
            emitToolExecutionEnd(finalized, stream);
            finalizedCalls.push(finalized);
            if (signal?.aborted) {
                break;
            }
            continue;
        }

        finalizedCalls.push(
            async () => {
                const executed = await executePreparedToolCall(preparation, signal, stream);
                const finalized = await finalizeExecutedToolCall(
                    currentContext,
                    assistantMessage,
                    preparation,
                    executed,
                    config,
                    signal
                );
                emitToolExecutionEnd(finalized, stream);
                return finalized;
            }
        );

        if (signal?.aborted) {
            break;
        }
    }

    const orderedFinaliedCalls = await Promise.all(
        finalizedCalls.map(
            (entry) => 
            (typeof entry === "function"? entry(): Promise.resolve(entry)),
        )
    );
    const messages: ToolResultMessage[] = [];
    for (const finalized of orderedFinaliedCalls) {
        const toolResultMessage = createToolResultMessage(finalized);
        emitToolResultMessage(toolResultMessage, stream);
        messages.push(toolResultMessage);
    }

    return {
        messages,
        terminate: shouldTerminateToolBatch(orderedFinaliedCalls),
    }
}



async function excuteToolCalls(
    currentContext: AgentContext,
    assistantMessage: AssistantMessage,
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
    stream : EventStream<AgentEvent, AgentMessage[]>,
): Promise<ExecutedToolCallBatch> {

    const toolCalls = assistantMessage.content
                                        .filter(
                                            (c) =>
                                                c.type === "toolCall"
                                        );
    const hasSequentialToolCall = toolCalls.some(
        (tc) => currentContext.tools?.find(
            (t) =>
                t.name === tc.name
        )?.executionMode === "sequential"
    );

    if (hasSequentialToolCall || config.toolExecution === "sequential") {
        return executeToolCallsSequential(
            currentContext,
            assistantMessage,
            toolCalls,
            config,
            signal,
            stream,
        );
    }

    return executeToolCallsParallel(
        currentContext,
            assistantMessage,
            toolCalls,
            config,
            signal,
            stream,
    )

}


function createErrorToolResult(message: string): AgentToolResult {
    return {
        content: [text(message)],
        details: {}
    }
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}



async function streamAssistantResponse(
    context: AgentContext,
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
    stream: EventStream<AgentEvent,AgentMessage[]>,
    streamFn?: StreamFn,
) : Promise<AssistantMessage> {

    let messages = context.messages;

    // [1] 同层变换（可选）：裁剪 / 注入 / 压缩，类型仍是 AgentMessage[]
    if (config.transformContext) {
        messages = await config.transformContext(messages, signal);
    }

    // [2] 跨层翻译（必填）：AgentMessage[] → Message[]，自定义转 user / 过滤 excludeFromContext
    const llmMessages = await config.convertToLlm(messages);

    const llmContext = {
        systemPrompt: context.systemPrompt,
        messages: llmMessages,
        tools: context.tools
    };




    const streamFunction = streamFn || streamSimple;

    const response = await streamFunction(
        config.model,
         llmContext
    );

    let partialMessage : AssistantMessage | null = null;
    let addedPartial = false;

    for await (const event of response) {
        switch (event.type) {
            case "start":
                partialMessage = event.partial;
                context.messages.push(partialMessage);
                addedPartial = true;
                stream.push(
                    {
                        type : "message_start",
                        message : {...partialMessage}
                    }
                );
                break;
            case "text_start":
            case "text_delta":
            case "text_end":
            case "thinking_start":
            case "thinking_delta":
            case "thinking_end":
            case "toolcall_start":
            case "toolcall_delta":
                if (partialMessage) {
                    partialMessage = event.partial;
                    context.messages[context.messages.length - 1] = partialMessage;
                    stream.push(
                        {
                            type : "message_update",
                            assistantMessageEvent : event,
                            message : {...partialMessage},
                        }
                    );
                }
                break;
            case "done":
            case "error": {
                const finalMessage = await response.result();
                if (addedPartial) {
                    context.messages[context.messages.length - 1] = finalMessage;
                } else {
                    context.messages.push(finalMessage);
                }

                if (!addedPartial) {
                    stream.push(
                        {
                            type : "message_start",
                            message : {...finalMessage},
                        }
                    );
                }
                stream.push(
                    {
                        type : "message_end",
                        message : finalMessage,
                    }
                )
                return finalMessage;
            }
        }
    }

    return await response.result();

}

function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, stream: EventStream<AgentEvent,AgentMessage[]>): void {
	 stream.push({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function emitToolResultMessage(toolResultMessage: ToolResultMessage, stream: EventStream<AgentEvent,AgentMessage[]>): void {
	stream.push({ type: "message_start", message: toolResultMessage });
	stream.push({ type: "message_end", message: toolResultMessage });
}