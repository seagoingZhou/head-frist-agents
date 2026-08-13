import type { 
    AgentMessage, 
    AgentContext, 
    AgentLoopConfig,
    AgentEventSink,
    StreamFn,
} from "./types";
import  {
    type AssistantMessage,
    streamSimple 
} from "pi-ai";



// 主循环 AgentLoop
export async function runAgentLoop(
    prompt: AgentMessage[],
    context: AgentContext,
    config: AgentLoopConfig,
    emit:AgentEventSink,
    signal? : AbortSignal,
    stream? : StreamFn
) : Promise<AgentMessage[]> {
    
    const newMessage: AgentMessage[] = [...prompt];
    const currentContext: AgentContext = { 
        ...context, 
        messages: [...context.messages, ...prompt] 
    };

    await emit({ type: "agent_start" });
    await emit({ type: "turn_start", turn: 1 });

    await runLoop(currentContext, newMessage, config, signal, emit, stream);

    return newMessage;
}


async function runLoop(
    initialContext: AgentContext,
    newMessages: AgentMessage[],
    initialConfig: AgentLoopConfig,
    signal: AbortSignal | undefined,
    emit: AgentEventSink,
    streamFn?: StreamFn
) : Promise<void> {

}



async function streamAssistantResponse(
    context: AgentContext,
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
    emit: AgentEventSink,
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

    const finalMessage = await response.result();


    return finalMessage;

}