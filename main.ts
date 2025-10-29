import { program } from 'commander';
import { IOEvent, main, Options } from './app';
import fs from 'fs';
import { terminal } from 'terminal-kit';
import readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

program
    .requiredOption('-c, --config-json <config-json>', 'The path to the config file')
    .option('-o, --output-file <output-file>', 'The path to save output logs')
    .option('-d, --debug', 'Enable debug mode');

program.parse();

const options: Options = JSON.parse(fs.readFileSync(program.opts().configJson, 'utf8')) as Options;

let outputStream: fs.WriteStream | undefined;
if (program.opts().outputFile) {
    outputStream = fs.createWriteStream(program.opts().outputFile, { flags: 'w' });
}

const formatMessage = (event: IOEvent) => {
    if (program.opts().debug) {
        event.message = '';
    }
    return program.opts().debug ? 
        JSON.stringify(event) : 
        event.toString();
};

main(options, (output: IOEvent) => {
    // Print to terminal
    const message = formatMessage(output);
    terminal(message);
    terminal('\n');
    
    // Save to file if output file was specified
    if (outputStream) {
        outputStream.write(message + '\n');
    }
}, async (question: IOEvent) => {
    return new Promise((resolve) => rl.question(formatMessage(question), resolve));
}).finally(() => {
    if (outputStream) {
        outputStream.end();
    }
    rl.close();
});
