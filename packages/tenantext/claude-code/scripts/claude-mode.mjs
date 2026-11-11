#!/usr/bin/env node
import { modeAction } from "./permission-profile.mjs";

try {
	console.log(modeAction(process.argv.slice(2)));
} catch (error) {
	console.error(error.message);
	process.exitCode = 2;
}
