import path from "node:path";



export interface EditOperations {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
    access: (path: string) => Promise<void>;
}
export interface LsOperations {
    exists: (path: string) => Promise<boolean>;
    stat: (path: string) => Promise<{ isDirectory(): boolean }>;
    readdir: (path: string) => Promise<string[]>;
}
export interface GrepOperations { isDirectory: () => Promise<boolean>; readFile: () => Promise<string> } // 桩
export interface FindOperations { exists: () => Promise<boolean>; glob: () => Promise<string[]> }        // 桩
export interface BashOperations { exec: () => Promise<{ stdout: string; exitCode: number }> }            // 桩
