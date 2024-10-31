import { program } from 'commander';
import { main, Options } from './app';
import fs from 'fs';
import { terminal } from 'terminal-kit';
import readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

program
    .option('-c, --config-json <config-json>', 'The path to the config file');

program.parse();

let options: Options = JSON.parse(fs.readFileSync(program.opts().configJson, 'utf8')) as Options;

if (!program.opts().configJson) {
    throw new Error('Config file is required');
}

main(options, (output: string) => {
    terminal(output);
    terminal('\n');
}, async (question: string) => {
    return new Promise((resolve) => rl.question(question, resolve));
}).finally(() => {
    rl.close();
});
