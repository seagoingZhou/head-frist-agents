
export interface BashOperations { 
    exec: () => Promise<{ stdout: string; exitCode: number }> 
}            // 桩
