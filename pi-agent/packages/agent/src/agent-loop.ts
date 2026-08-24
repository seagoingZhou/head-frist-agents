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

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

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

    void runAgentLoop(
        prompts,
        context,
        config,
        async (event) => {
            eventStream.push(event);
        },
        signal,
        streamFn
    ).then(
        (message) =>
            eventStream.end(message)
    )

    return eventStream;

}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
    const newMessages: AgentMessage[] = [...prompts];
    const currentContext: AgentContext = {
        ...context,
        messages: [...context.messages, ...prompts],
    };
    await emit({type:"agent_start"})
    await emit({type:"turn_start"})
    for (const prompt of prompts){
        await emit({type:"message_start", message:prompt})
        await emit({type:"message_end", message:prompt})
    }
    await runLoop(currentContext, newMessages, config, signal, emit, streamFn)

    return newMessages;
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
    emit: AgentEventSink,
    streamFn?: StreamFn
) : Promise<void> {

    let hasMoreToolCalls = true;
    let firstTurn = true;
    let queuedMessages : AgentMessage[] = (await config.getQueuedMessages?.()) || [];

    while(hasMoreToolCalls || queuedMessages.length > 0) {
        if (!firstTurn){
            await emit({type:"turn_start"});
        } else{
            firstTurn = false;
        }

        // 在每轮循环里、生成LLM助手回复前，把 queuedMessages 里的消息先排队注入上下文
        if (queuedMessages.length > 0){
            for (const message of queuedMessages){
                await emit({type:"message_start",message});
                await emit({type:"message_end",message});
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
            emit,
            streamFn
        )
        newMessages.push(assistantMessage)

        // 
        if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted"){
            await emit({type:"turn_end", message:assistantMessage, toolResults:[]})
            await emit({type:"agent_end",messages:newMessages})
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
                emit
            )
            toolResults.push(...executedToolBatch.messages);
            hasMoreToolCalls = !executedToolBatch.terminate;

            for (const result of toolResults) {
                currentAgentContext.messages.push(result);
                newMessages.push(result);
            }
        }

        await emit(
            {
                type : "turn_end",
                message : assistantMessage,
                toolResults
            }
        )

        queuedMessages = (await config.getQueuedMessages?.()) || [];

    }

    await emit(
        {
            type : "agent_end",
            messages : newMessages
        }
    );

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
    emit: AgentEventSink,
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
                        emit(
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
    emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
    const finalizedCalls: FinalizedToolCallOutcome[] = [];
    const messages: ToolResultMessage[] = [];

    for (const toolCall of toolCalls) {
        await emit(
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
            const executed = await executePreparedToolCall(preparation, signal, emit);
            finalized = await finalizeExecutedToolCall(
                currentContext,
                assistantMessage,
                preparation,
                executed,
                config,
                signal
            )
        }

        emitToolExecutionEnd(finalized, emit);

        const toolResultMessage = createToolResultMessage(finalized);

        emitToolResultMessage(toolResultMessage, emit);

        
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
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
    const finalizedCalls: FinalizedToolCallEntry[] = [];

    for (const toolCall of toolCalls) {
        await emit(
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
            emitToolExecutionEnd(finalized, emit);
            finalizedCalls.push(finalized);
            if (signal?.aborted) {
                break;
            }
            continue;
        }

        finalizedCalls.push(
            async () => {
                const executed = await executePreparedToolCall(preparation, signal, emit);
                const finalized = await finalizeExecutedToolCall(
                    currentContext,
                    assistantMessage,
                    preparation,
                    executed,
                    config,
                    signal
                );
                emitToolExecutionEnd(finalized, emit);
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
        emitToolResultMessage(toolResultMessage, emit);
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
    emit: AgentEventSink,
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
            emit,
        );
    }

    return executeToolCallsParallel(
        currentContext,
            assistantMessage,
            toolCalls,
            config,
            signal,
            emit,
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
    emit: AgentEventSink,
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
                await emit(
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
                    await emit(
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
                    await emit(
                        {
                            type : "message_start",
                            message : {...finalMessage},
                        }
                    );
                }
                await emit(
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

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink,): Promise<void>  {
	 await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink,): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}