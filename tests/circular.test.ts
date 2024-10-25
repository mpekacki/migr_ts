import { scanForCircularDependency } from '../circular';

describe('scanForCircularDependency', () => {
    it('should return empty array if no circular dependency is found', () => {
        expect(scanForCircularDependency([], {})).toEqual([]);
    });

    it('should indicate a field to clear if circular dependency is found', () => {
        expect(scanForCircularDependency([
                {
                    "Lookup_to_C__c": "a02KO0000014XX8YAM",
                    "attributes":
                    {
                        "type": "Custom_Object_B__c",
                        "url": "/services/data/v62.0/sobjects/Custom_Object_B__c/a01KO000000ZOGxYAO"
                    },
                    "Id": "a01KO000000ZOGxYAO",
                    "OwnerId": null
                },
                {
                    "Lookup_to_B__c": "a01KO000000ZOGxYAO",
                    "attributes":
                    {
                        "type": "Custom_Object_A__c",
                        "url": "/services/data/v62.0/sobjects/Custom_Object_A__c/a00KO0000016wtaYAA"
                    },
                    "Id": "a00KO0000016wtaYAA"
                },
                {
                    "Lookup_to_A__c": "a00KO0000016wtaYAA",
                    "attributes":
                    {
                        "type": "Custom_Object_C__c",
                        "url": "/services/data/v62.0/sobjects/Custom_Object_C__c/a02KO0000014XX8YAM"
                    },
                    "Id": "a02KO0000014XX8YAM"
                }
            ],
            {
                "Custom_Object_B__c": ["OwnerId", "Lookup_to_C__c"],
                "Custom_Object_A__c": ["OwnerId", "Lookup_to_B__c"],
                "Custom_Object_C__c": ["OwnerId"]
            }
        )).toEqual([
            { recordId: 'a02KO0000014XX8YAM', field: 'Lookup_to_A__c' }
        ]);
    });
});