import { GraphQLObjectType, GraphQLSchema } from "graphql";
import { uuid } from './uuid';

/**
 * Contains configuration options for the main function
 */
export declare type ValidityConfig = {
    wrapErrors: boolean;
    unhandledErrorWrapper?: Function;
    parentTypeName?: string;
}

// Indicates whether schema entity was already processed
export const Processed = Symbol();

/* An object which stores all validator functions
    required to be executed during graphql request */
export const FieldValidationDefinitions: any = {};

/**
 * Default error wrapper function to hide error info from end users
 *
 * @param {Error} error - unhandled error object
 * @returns {Error} - error object with critical data hidden
 */
function onUnhandledError(error: Error) {
    const id = uuid();

    console.error(`Unhandled error occured with id:${id}, stack:${error.stack}`);

    return new Error(`An internal error occured, with following id:${id}, please contact Administrator!`)
}

/**
 * DEPRECATED!!!
 * Must be used to wrap the extension variable on the graphqlHTTP object
 *
 * @param request - http request object, from the express middleware.
 * @returns {Function} - returns function for the extension variable
 * which adds additional changes to the result object.
 */
export function wrapExtension(request: any): Function {
    if (request) {
        request.__graphQLValidity = {
            ___validationResults: [],
            ___globalValidationResults: undefined
        };

        return function ({ result }: any) {
            const validity = request.__graphQLValidity;
            getResponseValidationResults(validity, result);

            return null;
        }
    }
    else {
        return function (...args: any[]) {
            return null;
        }
    }
}

/**
 * Middleware which will capture validation output and will add it to the original response
 *
 * @param req - express request
 * @param res - express response
 * @param next - next call
 */
export function graphQLValidityMiddleware(req: any, res: any, next: any) {
    try {
        let originalSend = res.send;
        req.__graphQLValidity = {
            ___validationResults: [],
            ___globalValidationResults: undefined
        };

        res.send = function (data: any) {
            try {
                let result = JSON.parse(data);
                const validity = req.__graphQLValidity;

                if (result.data) {
                    getResponseValidationResults(validity, result);
                    arguments[0] = JSON.stringify(result);
                }
            }
            catch (err) {
                console.error(err)
            }
            finally {
                originalSend.apply(res, Array.from(arguments));
            }
        }
    }
    catch (err) {
        console.error(err)
    }
    finally {
        next();
    }
}

/**
 * Builds errors array, using validation and global validation results
 *
 * @param validity - an object injected to request at the beginning of the http call
 * @param data - result of graphql call
 */
function getResponseValidationResults(validity: any, data: any) {
    let globalValidationResults = validity.___globalValidationResults
        || [];
    data.errors =
        (data.errors || [])
            .concat(
                validity.___validationResults.map(
                    error => {
                        return {
                            message: error.message
                        };
                    })
            )
            .concat(
                globalValidationResults.map(error => {
                    return {
                        message: error.message
                    };
                })
            );
}

/**
 * Top level wrapper for the GraphQL schema entities
 * which replaces resolve function if any found
 *
 * @param entity - GraphQL object entity
 * @param {ValidityConfig} config - setup options for the wrapper function
 */
export function wrapResolvers(entity: any, config?: ValidityConfig) {
    if (!config) {
        config = {
            wrapErrors: false,
            unhandledErrorWrapper: onUnhandledError,
            parentTypeName: ''
        }
    }
    else {
        config.unhandledErrorWrapper = config.unhandledErrorWrapper
            || onUnhandledError;
        config.parentTypeName = config.parentTypeName
            || '';
    }

    if (entity.constructor.name === 'GraphQLSchema') {
        wrapSchema(entity, config);
    } else if (entity.constructor.name === 'GraphQLObjectType') {
        wrapType(entity, config);
    } else {
        wrapField(entity, config);
    }
}

/**
 * Internal function which performs resolvers wrapping with common async function
 *
 * @param field - GraphQL entity field
 * @param {ValidityConfig} config - setup options for the wrapper function
 */
function wrapField(
    field: any,
    config: ValidityConfig,
    parentTypeName?: string
) {
    parentTypeName = parentTypeName || config.parentTypeName;

    const resolve = field.resolve;
    if (field[Processed] || !resolve) {
        return;
    }

    field[Processed] = true;
    field.resolve = async function (...args: any[]) {
        try {
            let request;
            for (let arg of [...args]) {
                if (arg && arg.__graphQLValidity) {
                    request = arg;
                    break;
                }
            }

            if (request) {
                let {
                    validationResults,
                    globalValidationResults
                } = getValidationResults(request);

                let {
                    validators,
                    globalValidators
                } = getValidators(field, parentTypeName);

                if (!globalValidationResults) {
                    const validity = request.__graphQLValidity;
                    validity.___globalValidationResults = [];
                    globalValidationResults = validity.___globalValidationResults;
                    for (let validator of globalValidators) {
                        Array.prototype.push.apply(
                            globalValidationResults,
                            await validator.call(this, ...args)
                        );
                    }
                }

                for (let validator of validators) {
                    Array.prototype.push.apply(
                        validationResults,
                        await validator.call(this, ...args)
                    );
                }
            }

            return await resolve.call(this, ...args);
        } catch (e) {
            if (config.wrapErrors) {
                throw config.unhandledErrorWrapper(e);
            }

            throw e;
        }
    };
}

/**
 * Returns lists of graphql validation messages arrays from request object
 *
 * @param request - express request object
 * @returns {{validationResults: any; globalValidationResults: any}} -
 * list of validation result messages for both local and global validators
 */
function getValidationResults(request: any) {
    let validationResults = request.__graphQLValidity.___validationResults;

    if (!validationResults) {
        request.__graphQLValidity.___validationResults = [];
        validationResults = request.__graphQLValidity.___validationResults;
    }

    let globalValidationResults = request.__graphQLValidity.___globalValidationResults;

    return {
        validationResults,
        globalValidationResults
    }
}

/**
 * Return list of local and global validators
 * @param field - field which will be validated
 * @param {string} parentTypeName - name of the parent object where field belongs to
 * @returns {{validators: T[]; globalValidators: (any | Array)}}
 * - list of local and global validator functions
 */
function getValidators(field: any, parentTypeName: string) {
    let validators =
        (
            FieldValidationDefinitions['*']
            || []
        ).concat
        (
            FieldValidationDefinitions[field.type]
            || []
        ).concat
        (
            FieldValidationDefinitions[parentTypeName + ':' + field.name]
            || []
        )

    let globalValidators = FieldValidationDefinitions['$'] || [];

    return {
        validators,
        globalValidators
    }
}

/**
 * Wraps each field of the GraphQLObjectType entity
 *
 * @param {GraphQLObjectType} type - GraphQLObject schema entity
 * @param {ValidityConfig} config - setup options for the wrapper function
 */
function wrapType(type: GraphQLObjectType, config: ValidityConfig) {
    if (type[Processed] || !type.getFields) {
        return;
    }

    const fields = type.getFields();
    for (const fieldName in fields) {
        if (!Object.hasOwnProperty.call(fields, fieldName)) {
            continue;
        }

        wrapField(fields[fieldName], config, type.name);
    }
}

/**
 * Wraps each GraphQLObjectType fields resolver for entire GraphQL Schema
 *
 * @param {GraphQLSchema} schema - schema object that must be wrapped
 * @param {ValidityConfig} config - setup options for the wrapper function
 */
function wrapSchema(schema: GraphQLSchema, config: ValidityConfig) {
    const types = schema.getTypeMap();
    for (const typeName in types) {
        if (!Object.hasOwnProperty.call(types, typeName)) {
            continue;
        }

        wrapType(<GraphQLObjectType>types[typeName], config);
    }
}