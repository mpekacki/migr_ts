import { scanForCircularDependency } from '../circular';

describe('scanForCircularDependency', () => {
    it('should return empty array if no circular dependency is found', () => {
        expect(scanForCircularDependency([], {})).toEqual([]);
    });

    it('should indicate a field to clear if circular dependency is found in 2 records', () => {
        expect(scanForCircularDependency([
            {
                "Lookup_to_B__c": "a01KO000000ZOGxYAO",
                "attributes":
                {
                    "type": "Custom_Object_A__c",
                    "url": "/services/data/v62.0/sobjects/Custom_Object_A__c/a00KO0000016wtaYAA"
                },
                "Id": "a00KO0000016wtaYAA",
                "OwnerId": "005KH000001TsIiYAK",
                "Null__c": null,
                "Num__c": 123
            },
            {
                "Lookup_to_A__c": "a00KO0000016wtaYAA",
                "attributes":
                {
                    "type": "Custom_Object_B__c",
                    "url": "/services/data/v62.0/sobjects/Custom_Object_B__c/a01KO000000ZOGxYAO"
                },
                "Id": "a01KO000000ZOGxYAO"
            }
        ], {
            "Custom_Object_A__c": ["OwnerId"],
            "Custom_Object_B__c": ["Lookup_to_A__c"]
        })).toEqual([
            { recordId: 'a00KO0000016wtaYAA', field: 'Lookup_to_B__c' }
        ]);
    });

    it('should indicate a field to clear if circular dependency is found in 3 records', () => {
        expect(scanForCircularDependency([
                {
                    "Lookup_to_B__c": "a01KO000000ZOGxYAO",
                    "attributes":
                    {
                        "type": "Custom_Object_A__c",
                        "url": "/services/data/v62.0/sobjects/Custom_Object_A__c/a00KO0000017wtaYAB"
                    },
                    "Id": "a00KO0000017wtaYAB",
                    "OwnerId": "005KH000001TsIiYAK"
                },
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
                    "Id": "a00KO0000016wtaYAA",
                    "OwnerId": "005KH000001TsIiYAK"
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

    it('should indicate only one field to clear if circular dependency is found in 2 records when no fields are required', () => {
        expect(scanForCircularDependency([
            {
                "Lookup_to_B__c": "a01KO000000ZOGxYAO",
                "attributes":
                {
                    "type": "Custom_Object_A__c",
                    "url": "/services/data/v62.0/sobjects/Custom_Object_A__c/a00KO0000016wtaYAA"
                },
                "Id": "a00KO0000016wtaYAA",
                "OwnerId": "005KH000001TsIiYAK"
            },
            {
                "Lookup_to_A__c": "a00KO0000016wtaYAA",
                "attributes":
                {
                    "type": "Custom_Object_B__c",
                    "url": "/services/data/v62.0/sobjects/Custom_Object_B__c/a01KO000000ZOGxYAO"
                },
                "Id": "a01KO000000ZOGxYAO"
            }
        ], {
            "Custom_Object_A__c": ["OwnerId"],
            "Custom_Object_B__c": ["OwnerId"]
        })).toEqual([
            { recordId: 'a00KO0000016wtaYAA', field: 'Lookup_to_B__c' }
        ]);
    });

    it('should find circular dependency when ids are inside text fields', () => {
        expect(scanForCircularDependency([
            {
                "Id": "a00KO0000016wtaYAA",
                "Description__c": "Here is some other id: a01KO000000ZOGxYAO",
                "attributes":
                {
                    "type": "Custom_Object_A__c",
                    "url": "/services/data/v62.0/sobjects/Custom_Object_A__c/a00KO0000016wtaYAA"
                }
            },
            {
                "Id": "a01KO000000ZOGxYAO",
                "Description__c": "Here is some other id: a00KO0000016wtaYAA",
                "attributes":
                {
                    "type": "Custom_Object_B__c",
                    "url": "/services/data/v62.0/sobjects/Custom_Object_B__c/a01KO000000ZOGxYAO"
                }
            }
        ], {
            "Custom_Object_A__c": [],
            "Custom_Object_B__c": ["Description__c"]
        })).toEqual([
            { recordId: 'a00KO0000016wtaYAA', field: 'Description__c' }
        ]);
    })

    it('should work for a large number of records and complete under 10 seconds', () => {
        const records = [];
        const num = 200;
        const createId = (i: number) => `a00KO0000016wtaYAA${i.toString().padStart(num.toString().length, '0')}`;
        for (let i = 0; i < num; i++) {
            records.push({
                "Id": createId(i),
                "Lookup__c": createId(i+1)
            });
        }
        records[records.length - 1].Lookup__c = createId(0);
        
        const startTime = performance.now();
        const result = scanForCircularDependency(records, { });
        const endTime = performance.now();
        
        const executionTime = (endTime - startTime) / 1000; // Convert to seconds
        
        expect(executionTime).toBeLessThan(10); // Should complete in under 10 seconds
        expect(result.length).toEqual(1);
    })
});