import { program } from 'commander';
import { main, Options } from './app';

program
    .option('-s, --source-org <source-org>', 'The alias of the source organization')
    .option('-t, --target-org <target-org>', 'The alias of the target organization')
    .option('-r, --record-id <record-id>', 'The ID of the record to migrate');

program.parse();

main(program.opts() as Options, (output: string) => {
    console.log(output);
});