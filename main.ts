import { program } from 'commander';
import { main } from './app';

program
    .option('-s, --source-org <source-org>', 'The alias of the source organization')
    .option('-t, --target-org <target-org>', 'The alias of the target organization')
    .option('-r, --record-id <record-id>', 'The ID of the record to migrate');

program.parse();

main(program.opts().sourceOrg, program.opts().targetOrg, program.opts().recordId, (output: string) => {
    console.log(output);
});