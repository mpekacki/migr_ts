import { Connection as SfConnection, AuthInfo } from '@salesforce/core';

async function main(orgA: string, orgB: string, recordId: string, onOutput: (output: string) => void) {
    console.log('orgA', orgA);
    console.log('orgB', orgB);
    console.log('recordId', recordId);

    const allAuths = await AuthInfo.listAllAuthorizations();
    console.log('allAuths', allAuths);

    const orgAUsername = allAuths.find(auth => auth.aliases!.includes(orgA))?.username;
    const orgBUsername = allAuths.find(auth => auth.aliases!.includes(orgB))?.username;

    const authInfoOptionsA: AuthInfo.Options = {
        username: orgAUsername!
    };
    const authInfoOptionsB: AuthInfo.Options = {
        username: orgBUsername!
    };
    const authInfoA = await AuthInfo.create(authInfoOptionsA);
    const authInfoB = await AuthInfo.create(authInfoOptionsB);

    const connA = await SfConnection.create({ authInfo: authInfoA });
    const connB = await SfConnection.create({ authInfo: authInfoB });

    const record = await connA.sobject('Account').retrieve(recordId);
    console.log('record', record);

    const newRecord = await connB.sobject('Account').create({Name: record.Name});
    console.log('newRecord', newRecord);
    
    const old2new = {
        [recordId]: newRecord.id
    };
    onOutput(JSON.stringify(old2new));
}

export { main };