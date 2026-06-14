import { program } from 'commander';
import { IOEvent, main, Options } from './app';
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

main(options, (output: IOEvent) => {
    // Print to terminal
    const message = ui.display(output);

    // Save to file if output file was specified
    if (outputStream) {
        outputStream.write(message + '\n');
    }
}, async (question: IOEvent) => {
    return ui.prompt(question);
}).finally(async () => {
    // Keep the final screen up until the user acknowledges it, then tear down.
    await ui.awaitExit?.();
    cleanup();
});
