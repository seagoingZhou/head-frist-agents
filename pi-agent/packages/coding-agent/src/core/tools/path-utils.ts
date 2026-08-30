import { access } from "node:fs/promises";
import { accessSync, constants } from "node:fs";


export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}