import { program } from 'commander';
import { main, Options } from './app';
import fs from 'fs';

program
    .option('-c, --config-json <config-json>', 'The path to the config file');

program.parse();

let options: Options;

if (program.opts().configJson) {
    options = JSON.parse(fs.readFileSync(program.opts().configJson, 'utf8')) as Options;
} else {
    options = program.opts() as Options;
}

main(options, (output: string) => {
    console.log(output);
});