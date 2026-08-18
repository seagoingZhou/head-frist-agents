
export interface FindOperations { 
    exists: () => Promise<boolean>; 
    glob: () => Promise<string[]> 
}        // 桩
