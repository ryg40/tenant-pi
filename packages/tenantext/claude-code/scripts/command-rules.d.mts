export interface CommandRule {
	action: string;
	reason: string;
}
export const COMMAND_RULES: Record<string, CommandRule>;
export function splitCommands(line: string): string[];
export function denyReason(line: string, rules?: Record<string, CommandRule>): string | undefined;
