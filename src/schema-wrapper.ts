/*!
 * The MIT License (MIT)
 *
 * Copyright (c) 2017 Vlad Martynenko <vladimir.martynenko.work@gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Contains configuration options for the main function
 */
import {
    DataValidationResult,
    onUnhandledError,
    ValidityConfig
} from "./helpers";
import {
    defaultProfilingResultHandler,
    storeProfilingInfo
} from "./profiling";
import {
    getValidationResults,
    getValidators
} from "./validation";

import hapiMiddleware from './hapi-middleware';
import expressMiddleware from './express-middleware';
import koaMiddleware from './koa-middleware';

// Indicates whether schema entity was already processed
export const Processed = Symbol();

let profilingResultHandler: any = {
    handler: defaultProfilingResultHandler
};

// Set of middleware functions for express, koa and hapi servers
export const graphQLValidityHapiMiddleware = hapiMiddleware(profilingResultHandler);
export const graphQLValidityExpressMiddleware = expressMiddleware(profilingResultHandler);
export const graphQLValidityKoaMiddleware = koaMiddleware(profilingResultHandler);

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
            enableProfiling: false,
            unhandledErrorWrapper: onUnhandledError
        }
    }
    else {
        config.unhandledErrorWrapper = config.unhandledErrorWrapper
            || onUnhandledError;

        if (config.profilingResultHandler) {
            profilingResultHandler.handler = config.profilingResultHandler ?
                config.profilingResultHandler : profilingResultHandler.handler;
        }
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
    config: ValidityConfig
) {
    const resolve = field.resolve;
    if (field[Processed] || !resolve) {
        return;
    }

    field[Processed] = true;
    field.resolve = async function (...args: any[]) {
        try {
            // profiling start time
            var pst = Date.now();
            let parentTypeName;
            let ast;
            let validity;
            for (let arg of [...args]) {
                if (arg && arg.rootValue && arg.rootValue.__graphQLValidity) {
                    validity = arg.rootValue.__graphQLValidity;
                }

                if (arg && arg.parentType) {
                    ast = arg;
                    parentTypeName = arg.parentType;
                }
            }

            if (validity) {
                let {
                    validationResults,
                    globalValidationResults
                } = getValidationResults(validity);

                let {
                    validators,
                    globalValidators
                } = getValidators(field, parentTypeName);

                if (!globalValidationResults) {
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

            // validation end time
            const vet = Date.now();
            let resolveOutput = await resolve.call(this, ...args);

            let result = resolveOutput;

            if (resolveOutput instanceof DataValidationResult) {
                if (validity) {
                    let {
                        validationResults
                    } = getValidationResults(validity);

                    if (resolveOutput.errors && resolveOutput.errors.length) {
                        Array.prototype.push.apply(
                            validationResults,
                            resolveOutput.errors
                        );
                    }
                }

                result = resolveOutput.data;
            }

            // execution end time
            const eet = Date.now();

            try {
                if (validity && config.enableProfiling) {
                    storeProfilingInfo(validity, ast.path, {
                        name: field.name,
                        validation: (vet - pst),
                        execution: (eet - pst),
                        fieldsExecution: 0,
                        totalExecution: (eet - pst) - (vet - pst)
                    });
                }
            }
            catch (err) {
                console.error('Profiling failed!', err);
            }

            return result;
        } catch (e) {
            if (config.wrapErrors) {
                throw config.unhandledErrorWrapper(e);
            }

            throw e;
        }
    };
}

/**
 * Wraps each field of the GraphQLObjectType entity
 *
 * @param {GraphQLObjectType} type - GraphQLObject schema entity
 * @param {ValidityConfig} config - setup options for the wrapper function
 */
function wrapType(type: any, config: ValidityConfig) {
    if (type[Processed] || !type.getFields) {
        return;
    }

    const fields = type.getFields();
    for (const fieldName in fields) {
        if (!Object.hasOwnProperty.call(fields, fieldName)) {
            continue;
        }

        wrapField(fields[fieldName], config);
    }
}

/**
 * Wraps each GraphQLObjectType fields resolver for entire GraphQL Schema
 *
 * @param {GraphQLSchema} schema - schema object that must be wrapped
 * @param {ValidityConfig} config - setup options for the wrapper function
 */
function wrapSchema(schema: any, config: ValidityConfig) {
    const types = schema.getTypeMap();
    for (const typeName in types) {
        if (!Object.hasOwnProperty.call(types, typeName)) {
            continue;
        }

        wrapType(<any>types[typeName], config);
    }
}