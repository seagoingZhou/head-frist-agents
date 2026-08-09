
export type TextContent = {
  type: "text";
  text: string;
};

export type ToolCallContent = {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string,unknown>;
};

export type Usage = {
    input:number;
    output:number;
    totalTokens:number;
};

export type UserMessage = {
  role: "user";
  content: TextContent [];
  timestamp: number;
};

export type AssistantMessage = {
    role: "assistant";
    content: Array<TextContent | ToolCallContent>;
    stopReason?: "stop" | "toolUse" | "error" | "aborted";
    usage?: Usage;
    timestamp: number;
    errorMessage?: string;
};

export type ToolResultMessage = {
    role:"toolResult";
    toolCallId: string;
    toolName: string;
    content: TextContent[];
    details?:unknown;
    isError?: boolean;
    timestamp: number;
};

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

export type ToolDefinition = {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
};

export type SessionEntry = 
    | {
        type:"session";
        version: 1;
        id: string; 
        timestamp: 
        string;cwd:"string"
    }
    | {
        type:"message"; 
        id: string; 
        parentId:null|string; 
        timestamp: string; 
        message: AgentMessage
    }
    | {
        type:"compact"; 
        id: string; 
        parentId:null|string; 
        timestamp: string; 
        summary: string;
        firstKeptEntryId:string; 
        tokensBefore:number
    };