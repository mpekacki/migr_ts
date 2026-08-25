import './bootstrap'; // must stay first - see bootstrap.ts
import { program } from 'commander';
import { main } from './app';
import { Options } from './config';
import IOEvent from './ioevent';
import fs from 'fs';
import { UI } from './ui/ui';
import { TerminalKitUI } from './ui/terminal-kit/terminal';
import { TuiUI } from './ui/tui/tui';

program
    .requiredOption('-c, --config-json <config-json>', 'The path to the config file')
    .option('-o, --output-file <output-file>', 'The path to save output logs')
    .option('-d, --debug', 'Enable debug mode')
    .option('-p, --plain', 'Use the plain streaming UI instead of the full-screen TUI');

program.parse();

const opts = program.opts();

// The full-screen TUI is the default. Debug mode and --plain fall back to the
// line-based UI, which is friendlier for piping and reading raw JSON.
const usePlain = opts.plain || opts.debug;
const ui: UI = usePlain ? new TerminalKitUI(opts.debug) : new TuiUI(opts.debug);

const options: Options = JSON.parse(fs.readFileSync(opts.configJson, 'utf8')) as Options;

let outputStream: fs.WriteStream | undefined;
if (opts.outputFile) {
    outputStream = fs.createWriteStream(opts.outputFile, { flags: 'w' });
}

// Make sure the alternate screen is always restored, even on Ctrl+C.
const cleanup = () => {
    if (outputStream) {
        outputStream.end();
        outputStream = undefined;
    }
    ui.close();
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// Errors thrown before the UI is torn down would otherwise vanish into the
// alternate screen buffer (or get lost with no handler at all). Always log
// them to the output file (if any) and the restored terminal before exiting.
let reportedFatal = false;
const reportFatal = (err: unknown) => {
    if (reportedFatal) return;
    reportedFatal = true;
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    if (outputStream) {
        outputStream.write(`FATAL: ${message}\n`);
    }
    cleanup();
    console.error(message);
    process.exitCode = 1;
};
process.on('uncaughtException', reportFatal);
process.on('unhandledRejection', reportFatal);

main(options, (output: IOEvent) => {
    // Print to terminal
    const message = ui.display(output);

    // Save to file if output file was specified
    if (outputStream) {
        outputStream.write(message + '\n');
    }
}, async (question: IOEvent) => {
    return ui.prompt(question);
}).then(async () => {
    // Keep the final screen up until the user acknowledges it, then tear down.
    await ui.awaitExit?.();
    cleanup();
}).catch(reportFatal);
