import { program } from 'commander';
import { IOEvent, main, Options } from './app';
import fs from 'fs';
import { TerminalKitUI } from './ui/terminal-kit/terminal';

program
    .requiredOption('-c, --config-json <config-json>', 'The path to the config file')
    .option('-o, --output-file <output-file>', 'The path to save output logs')
    .option('-d, --debug', 'Enable debug mode');

program.parse();

const ui = new TerminalKitUI(program.opts().debug);

const options: Options = JSON.parse(fs.readFileSync(program.opts().configJson, 'utf8')) as Options;

let outputStream: fs.WriteStream | undefined;
if (program.opts().outputFile) {
    outputStream = fs.createWriteStream(program.opts().outputFile, { flags: 'w' });
}

main(options, (output: IOEvent) => {
    // Print to terminal
    const message = ui.display(output);
    
    // Save to file if output file was specified
    if (outputStream) {
        outputStream.write(message + '\n');
    }
}, async (question: IOEvent) => {
    return ui.prompt(question);
}).finally(() => {
    if (outputStream) {
        outputStream.end();
    }
    ui.close();
});
