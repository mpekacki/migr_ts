import { Schema, SObjectRecord } from "jsforce";
import { createHash } from "crypto";

type EmailAnonymizationMode = 'obfuscate' | 'sanitize';

type PreprocessStrategy = {
    emailAnonymization?: {
        mode: EmailAnonymizationMode;
        template?: string;
        customTransformer?: (email: string) => string;
    };
}

const applyTemplate = (value: string, template: string): string => {
    return template.replace('{0}', value);
};

const normalizeTemplate = (template: string): string => {
    // If template doesn't contain {0}, assume it's a simple domain and convert to {0}@domain
    if (!template.includes('{0}')) {
        return `{0}@${template}`;
    }
    return template;
};

const defaultEmailObfuscator = (email: string, template: string = '{0}@example.com'): string => {
    const hash = createHash('sha256').update(email.toLowerCase()).digest('hex');
    const shortHash = hash.substring(0, 8);
    const normalizedTemplate = normalizeTemplate(template);
    return applyTemplate(`user${shortHash}`, normalizedTemplate);
};

const defaultEmailSanitizer = (email: string, template: string = '{0}@example.com'): string => {
    // Convert john.smith@gmail.com to john.smith.at.gmail.com
    const sanitized = email.replace('@', '.at.');
    const normalizedTemplate = normalizeTemplate(template);
    return applyTemplate(sanitized, normalizedTemplate);
};

export const preprocessData = (recordsByIds: Record<string, SObjectRecord<Schema, string>>, strategy: PreprocessStrategy) => {
    if (strategy.emailAnonymization) {
        let transformer: (email: string) => string;

        if (strategy.emailAnonymization.customTransformer) {
            transformer = strategy.emailAnonymization.customTransformer;
        } else if (strategy.emailAnonymization.mode === 'obfuscate') {
            const template = strategy.emailAnonymization.template || '{0}@example.com';
            transformer = (email: string) => defaultEmailObfuscator(email, template);
        } else if (strategy.emailAnonymization.mode === 'sanitize') {
            const template = strategy.emailAnonymization.template || '{0}@example.com';
            transformer = (email: string) => defaultEmailSanitizer(email, template);
        } else {
            return; // Unknown mode, do nothing
        }

        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

        for (const recordId in recordsByIds) {
            const record = recordsByIds[recordId];
            for (const field in record) {
                // if value contains an email address, replace only the email parts
                if (record[field] && typeof record[field] === 'string' && record[field].includes('@')) {
                    record[field] = (record[field] as string).replace(emailRegex, (match) => transformer(match));
                }
            }
        }
    }
}
