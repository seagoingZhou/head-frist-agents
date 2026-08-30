

export interface GrepOperations { 
    isDirectory: () => Promise<boolean>; 
    readFile: () => Promise<string> 
} // 桩
