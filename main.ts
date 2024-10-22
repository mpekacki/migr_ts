import { program } from 'commander';
import { main, Options } from './app';
import fs from 'fs';

program
    .option('-s, --source-org <source-org>', 'The alias of the source organization')
    .option('-t, --target-org <target-org>', 'The alias of the target organization')
    .option('-r, --record-id <record-id>', 'The ID of the record to migrate')
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