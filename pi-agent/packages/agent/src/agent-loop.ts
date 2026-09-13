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

/**
 * 跑一轮 agent loop:把 prompts 追加进上下文快照后进入 `runLoop`,一直跑到没有更多工具调用、也没有排队消息。
 * 返回本次新增的消息(prompts + assistant + toolResult)。事件经 `emit` 逐条发出。
 */
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

/**
 * 从"已有上下文"续跑(不追加新 prompts):先守守卫——上下文为空、或末条是 assistant 时直接抛错——
 * 然后进 `runLoop` 产出下一个 assistant。返回本次新增的消息。
 * (对应 `Agent.continue()` 在末条非 assistant 时走的 `runContinuation()` 路径。)
 */
export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
    return new EventStream<AgentEvent, AgentMessage[]>(
        (event:AgentEvent) => event.type === "agent_end",
        (event:AgentEvent) => (event.type === "agent_end" ? event.messages : [])
            
    );
}



/**
 * 主循环(两层 while):
 * - 内层:每轮「注入 pending → 流式出 assistant → 执行工具 → 发 turn_end →
 *   prepareNextTurn 覆盖下轮状态 → shouldStopAfterTurn 判定停 → 重新轮询 steering」;
 * - 外层:内层因"无更多工具调用、无 steering"停下后,再查 follow-up;有则塞回内层继续,无则退出。
 * 终止方式:assistant 报错/被中止(提前 return)、shouldStopAfterTurn 判定停、或内外层均无更多消息。
 */
async function runLoop(
    initialContext: AgentContext,
    newMessages: AgentMessage[],
    initialConfig: AgentLoopConfig,
    signal: AbortSignal | undefined,
    emit: AgentEventSink,
    streamFn?: StreamFn
) : Promise<void> {

    let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// 起始先取一次 steering 消息:用户可能在等待期间打了字,应尽早注入
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

    while (true) {
        let hasMoreToolCalls = true;

        // 内层循环:处理工具调用与 steering 消息(每轮 = 一次 assistant 回复 + 其工具执行)
        while(hasMoreToolCalls || pendingMessages.length > 0) {
            if (!firstTurn){
                await emit({type:"turn_start"});
            } else{
                firstTurn = false;
            }

            // 在每轮循环里、生成LLM助手回复前，把 pendingMessages 里的消息先排队注入上下文
            if (pendingMessages.length > 0){
                for (const message of pendingMessages){
                    await emit({type:"message_start",message});
                    await emit({type:"message_end",message});
                    initialContext.messages.push(message);
                    newMessages.push(message);
                }
                pendingMessages = [];
            }
            

            // LLM助手 流式回复
            const assistantMessage = await streamAssistantResponse(
                initialContext,
                config,
                signal,
                emit,
                streamFn
            )
            newMessages.push(assistantMessage)

            // assistant 报错或被中止 → 收尾本回合(turn_end)并直接发 agent_end,不再处理工具调用
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
                    initialContext,
                    assistantMessage,
                    config,
                    signal,
                    emit
                )
                toolResults.push(...executedToolBatch.messages);
                hasMoreToolCalls = !executedToolBatch.terminate;

                for (const result of toolResults) {
                    initialContext.messages.push(result);
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

			// 回合收尾:构造"下一回合决策"用的上下文,交给 prepareNextTurn / shouldStopAfterTurn
            const nextTurnContext = {
				message: assistantMessage,
				toolResults,
				context: currentContext,
				newMessages,
			};

            // prepareNextTurn:允许替换下一回合的 context / model / thinking;返回非空则覆盖
            const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					// thinkingLevel:"off" → reasoning 置 undefined(关思考);显式给了就覆盖
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}

			// shouldStopAfterTurn:判定"本回合后应优雅停止"→ 直接发 agent_end 返回,不再发起新的 provider 请求
			if (
				await config.shouldStopAfterTurn?.({
					message: assistantMessage,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// 重新轮询 steering:本轮工具执行期间用户可能又插了话,作为下一轮内循环的 pending
			pendingMessages = (await config.getSteeringMessages?.()) || [];
        }

        // 外层:agent 本将停止 —— 检查 follow-up(后续)消息
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// 有 follow-up → 作为 pending 注入,继续内层循环
			pendingMessages = followUpMessages;
			continue;
		}

		// 既无 steering 也无 follow-up → 结束外层循环
		break;
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