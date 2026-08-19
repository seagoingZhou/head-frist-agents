import type { 
    AgentMessage, 
    AgentContext, 
    AgentLoopConfig,
    AgentEventSink,
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
    text
} from "pi-ai";


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
    let queuedAfterTools : AgentMessage[] | null = null;

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
        hasMoreToolCalls = toolCalls.length > 0;

        const toolResults : ToolResultMessage[] = [];
        if (hasMoreToolCalls) {
            const toolExecution = await excuteToolCalls(
                currentAgentContext.tools,
                assistantMessage,
                signal,
                stream,
                config.getQueuedMessages
            )
            toolResults.push(...toolExecution.toolResults);
            queuedAfterTools = toolExecution.queuedMessages ?? null;

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

        if (queuedAfterTools && queuedAfterTools.length > 0) {
            queuedMessages = queuedAfterTools;
            queuedAfterTools = null;
        } else {
            queuedMessages = (await config.getQueuedMessages?.()) || [];
        }

    }
    stream.push(
        {
            type : "agent_end",
            messages : newMessages
        }
    );

    stream.end(newMessages);

}

async function excuteToolCalls(
        tools : AgentTool[] | undefined,
        assistantMessage : AssistantMessage,
        signal : AbortSignal | undefined,
        stream : EventStream<AgentEvent, AgentMessage[]>,
        getQueuedMessages ?: AgentLoopConfig["getQueuedMessages"],
    ): Promise<{ toolResults : ToolResultMessage[],queuedMessages ?: AgentMessage[]}> {
    const results : ToolResultMessage[] = [];
    let queuedMessages : AgentMessage[] | undefined;
    const toolCalls = assistantMessage.content
                                        .filter(
                                            (c) =>
                                                c.type === "toolCall"
                                        );
    const toolResults: ToolResultMessage[] = []
    for (let index = 0; index < toolCalls.length; index++) {
        const toolCall = toolCalls[index];
        const tool = tools?.find((t) => t.name === toolCall.name);

        stream.push(
            {
                type : "tool_execution_start",
                toolCallId : toolCall.id,
                toolName : toolCall.name,
                args : toolCall.arguments
            }
        );

        let result : AgentToolResult;
        let isError = false;

        try {
            if (!tool) {
                throw new Error(`Tool ${toolCall.name} not found`);
            }
            result = await tool.execute(
                toolCall.id,
                toolCall.arguments,
                signal
            );
        } catch (error) {
            result = createErrorToolResult(
                error instanceof Error ?
                error.message:
                String(error)
            );
            isError = true;
        }

        stream.push(
            {
                type: "tool_execution_end",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                result,
                partialResult: result,
            }
        )
        const toolResultMessage: ToolResultMessage = {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: result.content,
            details: result.details,
            isError,
            timestamp: Date.now(),
        };
        stream.push(
            {
                type: "message_start",
                message: toolResultMessage
            }
        );
        stream.push(
            {
                type: "message_end",
                message: toolResultMessage
            }
        );
        toolResults.push(toolResultMessage);

    }

    return {toolResults:toolResults, queuedMessages}
}


function createErrorToolResult(message: string): AgentToolResult {
    return {
        content: [text(message)],
        details: {}
    }
}



async function streamAssistantResponse(
    context: AgentContext,
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
    stream: EventStream<AgentEvent,AgentMessage[]>,
    streamFn?: StreamFn,
) : Promise<AssistantMessage> {

    let messages = context.messages;

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