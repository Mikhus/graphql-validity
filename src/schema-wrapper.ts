export const Processed = Symbol();
export const FieldValidationDefinitions: any = {};

let validationResults: any[] = [];

export function wrapExtension({ result }: any) {
    result.errors = validationResults.map(error => {
        return {
            message: error.message
        };
    });

    validationResults = [];
    return null;
}

export function wrapResolvers(entity: any, parentTypeName: string = '') {
    if (entity.constructor.name === 'GraphQLSchema') {
        wrapSchema(entity);
    } else if (entity.constructor.name === 'GraphQLObjectType') {
        wrapType(entity);
    } else {
        wrapField(entity, parentTypeName);
    }
}

function wrapField(field: any, parentTypeName: string) {
    const resolve = field.resolve;
    if (field[Processed] || !resolve) {
        return;
    }

    field[Processed] = true;
    field.resolve = async function (...args: any[]) {
        try {
            let validators = FieldValidationDefinitions[field.type]
                || FieldValidationDefinitions[parentTypeName + ':' + field.name]
                || [];
            for (let validator of validators) {
                Array.prototype.push.apply(
                    validationResults,
                    await validator.call(this, ...args)
                );
            }

            return await resolve.call(this, ...args);
        } catch (e) {
            throw e;
        }
    };
}

function wrapType(type: any) {
    if (type[Processed] || !type.getFields) {
        return;
    }

    const fields = type.getFields();
    for (const fieldName in fields) {
        if (!Object.hasOwnProperty.call(fields, fieldName)) {
            continue;
        }

        wrapField(fields[fieldName], type);
    }
}

function wrapSchema(schema: any) {
    const types = schema.getTypeMap();
    for (const typeName in types) {
        if (!Object.hasOwnProperty.call(types, typeName)) {
            continue;
        }

        wrapType(types[typeName]);
    }
}