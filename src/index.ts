import { getStream } from "./get-stream";
import * as _ from "lodash";
import { List, Map, OrderedMap, OrderedSet } from "immutable";
import { Readable } from "stream";
import * as URI from "urijs";

import * as targetLanguages from "./Language/All";
import { TargetLanguage } from "./TargetLanguage";
import { SerializedRenderResult, Annotation, Location, Span } from "./Source";
import { assertNever, assert, panic, defined, forEachSync } from "./Support";
import { CompressedJSON, Value } from "./CompressedJSON";
import { combineClasses, findSimilarityCliques } from "./CombineClasses";
import { addTypesInSchema, Ref, definitionRefsInSchema, checkJSONSchema } from "./JSONSchemaInput";
import { JSONSchema, JSONSchemaStore } from "./JSONSchemaStore";
import { TypeInference } from "./Inference";
import { inferMaps } from "./InferMaps";
import { TypeGraphBuilder } from "./TypeBuilder";
import { TypeGraph, noneToAny, optionalToNullable } from "./TypeGraph";
import { makeNamesTypeAttributes } from "./TypeNames";
import { makeGraphQLQueryTypes } from "./GraphQL";
import { gatherNames } from "./GatherNames";
import { inferEnums, flattenStrings } from "./InferEnums";
import { descriptionTypeAttributeKind } from "./TypeAttributes";
import { flattenUnions } from "./FlattenUnions";
import { resolveIntersections } from "./ResolveIntersections";

// Re-export essential types and functions
export { TargetLanguage } from "./TargetLanguage";
export { SerializedRenderResult, Annotation } from "./Source";
export { all as languages, languageNamed } from "./Language/All";
export { OptionDefinition } from "./RendererOptions";

const stringToStream = require("string-to-stream");

export function getTargetLanguage(nameOrInstance: string | TargetLanguage): TargetLanguage {
    if (typeof nameOrInstance === "object") {
        return nameOrInstance;
    }
    const language = targetLanguages.languageNamed(nameOrInstance);
    if (language !== undefined) {
        return language;
    }
    throw new Error(`'${nameOrInstance}' is not yet supported as an output language.`);
}

export type RendererOptions = { [name: string]: string };

export type StringInput = string | Readable;

export interface JSONTypeSource {
    name: string;
    samples: StringInput[];
    description?: string;
}

export function isJSONSource(source: TypeSource): source is JSONTypeSource {
    return "samples" in source;
}

export interface SchemaTypeSource {
    name: string;
    uri?: string;
    schema?: StringInput;
    topLevelRefs?: string[];
}

export function isSchemaSource(source: TypeSource): source is SchemaTypeSource {
    return !("query" in source) && !("samples" in source);
}

export interface GraphQLTypeSource {
    name: string;
    schema: any;
    query: StringInput;
}

export function isGraphQLSource(source: TypeSource): source is GraphQLTypeSource {
    return "query" in source;
}

export type TypeSource = GraphQLTypeSource | JSONTypeSource | SchemaTypeSource;

export interface Options {
    lang: string | TargetLanguage;
    sources: TypeSource[];
    handlebarsTemplate: string | undefined;
    findSimilarClassesSchemaURI: string | undefined;
    inferMaps: boolean;
    inferEnums: boolean;
    inferDates: boolean;
    alphabetizeProperties: boolean;
    allPropertiesOptional: boolean;
    combineClasses: boolean;
    fixedTopLevels: boolean;
    noRender: boolean;
    leadingComments: string[] | undefined;
    rendererOptions: RendererOptions;
    indentation: string | undefined;
    outputFilename: string;
    schemaStore: JSONSchemaStore | undefined;
    debugPrintGraph: boolean | undefined;
}

const defaultOptions: Options = {
    lang: "ts",
    sources: [],
    handlebarsTemplate: undefined,
    findSimilarClassesSchemaURI: undefined,
    inferMaps: true,
    inferEnums: true,
    inferDates: true,
    alphabetizeProperties: false,
    allPropertiesOptional: false,
    combineClasses: true,
    fixedTopLevels: false,
    noRender: false,
    leadingComments: undefined,
    rendererOptions: {},
    indentation: undefined,
    outputFilename: "stdout",
    schemaStore: undefined,
    debugPrintGraph: false
};

type InputData = {
    samples: { [name: string]: { samples: Value[]; description?: string } };
    schemas: { [name: string]: { ref: Ref } };
    graphQLs: { [name: string]: { schema: any; query: string } };
};

function toReadable(source: string | Readable): Readable {
    return _.isString(source) ? stringToStream(source) : source;
}

async function toString(source: string | Readable): Promise<string> {
    return _.isString(source) ? source : await getStream(source);
}

class InputJSONSchemaStore extends JSONSchemaStore {
    constructor(private readonly _inputs: Map<string, StringInput>, private readonly _delegate?: JSONSchemaStore) {
        super();
    }

    async fetch(address: string): Promise<JSONSchema | undefined> {
        const maybeInput = this._inputs.get(address);
        if (maybeInput !== undefined) {
            return checkJSONSchema(JSON.parse(await toString(maybeInput)));
        }
        if (this._delegate === undefined) {
            return panic(`Schema URI ${address} requested, but no store given`);
        }
        return await this._delegate.fetch(address);
    }
}

export class Run {
    private _compressedJSON: CompressedJSON;
    private _allInputs: InputData;
    private _options: Options;
    private _schemaStore: JSONSchemaStore | undefined;

    constructor(options: Partial<Options>) {
        this._options = _.mergeWith(_.clone(options), defaultOptions, (o, s) => (o === undefined ? s : o));
        this._allInputs = { samples: {}, schemas: {}, graphQLs: {} };

        const mapping = getTargetLanguage(this._options.lang).stringTypeMapping;
        const makeDate = mapping.date !== "string";
        const makeTime = mapping.time !== "string";
        const makeDateTime = mapping.dateTime !== "string";
        this._compressedJSON = new CompressedJSON(makeDate, makeTime, makeDateTime);
    }

    private getSchemaStore(): JSONSchemaStore {
        return defined(this._schemaStore);
    }

    private async makeGraph(): Promise<TypeGraph> {
        const targetLanguage = getTargetLanguage(this._options.lang);
        const stringTypeMapping = targetLanguage.stringTypeMapping;
        const conflateNumbers = !targetLanguage.supportsUnionsWithBothNumberTypes;
        const haveSchemas = Object.getOwnPropertyNames(this._allInputs.schemas).length > 0;
        const typeBuilder = new TypeGraphBuilder(
            stringTypeMapping,
            this._options.alphabetizeProperties,
            this._options.allPropertiesOptional,
            haveSchemas,
            false
        );

        // JSON Schema
        let schemaInputs = Map(this._allInputs.schemas).map(({ ref }) => ref);
        if (this._options.findSimilarClassesSchemaURI !== undefined) {
            schemaInputs = schemaInputs.set("ComparisonBaseRoot", Ref.parse(this._options.findSimilarClassesSchemaURI));
        }
        if (!schemaInputs.isEmpty()) {
            await addTypesInSchema(typeBuilder, this.getSchemaStore(), schemaInputs);
        }

        // GraphQL
        const numInputs = Object.keys(this._allInputs.graphQLs).length;
        Map(this._allInputs.graphQLs).forEach(({ schema, query }, name) => {
            const newTopLevels = makeGraphQLQueryTypes(name, typeBuilder, schema, query);
            newTopLevels.forEach((t, actualName) => {
                typeBuilder.addTopLevel(numInputs === 1 ? name : actualName, t);
            });
        });

        // JSON
        const doInferEnums = this._options.inferEnums;
        const numSamples = Object.keys(this._allInputs.samples).length;
        if (numSamples > 0) {
            const inference = new TypeInference(typeBuilder, doInferEnums, this._options.inferDates);

            Map(this._allInputs.samples).forEach(({ samples, description }, name) => {
                const tref = inference.inferType(
                    this._compressedJSON as CompressedJSON,
                    makeNamesTypeAttributes(name, false),
                    samples,
                    this._options.fixedTopLevels
                );
                typeBuilder.addTopLevel(name, tref);
                if (description !== undefined) {
                    const attributes = descriptionTypeAttributeKind.makeAttributes(OrderedSet([description]));
                    typeBuilder.addAttributes(tref, attributes);
                }
            });
        }

        let graph = typeBuilder.finish();
        if (this._options.debugPrintGraph === true) {
            graph.setPrintOnRewrite();
            graph.printGraph();
        }

        if (haveSchemas) {
            let intersectionsDone = false;
            let unionsDone = false;
            do {
                const graphBeforeRewrites = graph;
                if (!intersectionsDone) {
                    [graph, intersectionsDone] = resolveIntersections(graph, stringTypeMapping);
                }
                if (!unionsDone) {
                    [graph, unionsDone] = flattenUnions(graph, stringTypeMapping, conflateNumbers);
                }

                if (graph === graphBeforeRewrites) {
                    assert(intersectionsDone && unionsDone, "Graph didn't change but we're not done");
                }
            } while (!intersectionsDone || !unionsDone);
        }

        if (this._options.findSimilarClassesSchemaURI !== undefined) {
            return graph;
        }

        if (this._options.combineClasses) {
            graph = combineClasses(graph, stringTypeMapping, this._options.alphabetizeProperties, conflateNumbers);
        }
        if (doInferEnums) {
            graph = inferEnums(graph, stringTypeMapping);
        }
        graph = flattenStrings(graph, stringTypeMapping);
        if (this._options.inferMaps) {
            graph = inferMaps(graph, stringTypeMapping, conflateNumbers);
        }
        graph = noneToAny(graph, stringTypeMapping);
        if (!targetLanguage.supportsOptionalClassProperties) {
            graph = optionalToNullable(graph, stringTypeMapping);
        }
        // Sometimes we combine classes in ways that will the order come out
        // differently compared to what it would be from the equivalent schema,
        // so we always just garbage collect to get a defined order and be done
        // with it.
        // FIXME: We don't actually have to do this if any of the above graph
        // rewrites did anything.  We could just check whether the current graph
        // is different from the one we started out with.
        graph = graph.garbageCollect(this._options.alphabetizeProperties);

        gatherNames(graph);
        if (this._options.debugPrintGraph === true) {
            console.log("\n# gather names");
            graph.printGraph();
        }

        return graph;
    }

    private makeSimpleTextResult(lines: string[]): OrderedMap<string, SerializedRenderResult> {
        return OrderedMap([[this._options.outputFilename, { lines, annotations: List() }]] as [
            string,
            SerializedRenderResult
        ][]);
    }

    private addSchemaInput(name: string, ref: Ref): void {
        if (_.has(this._allInputs.schemas, name)) {
            throw new Error(`More than one schema given for ${name}`);
        }

        this._allInputs.schemas[name] = { ref };
    }

    public run = async (): Promise<OrderedMap<string, SerializedRenderResult>> => {
        const targetLanguage = getTargetLanguage(this._options.lang);

        let schemaInputs: Map<string, StringInput> = Map();
        let schemaSources: List<[uri.URI, SchemaTypeSource]> = List();
        for (const source of this._options.sources) {
            if (!isSchemaSource(source)) continue;
            const { uri, schema } = source;

            let normalizedURI: uri.URI;
            if (uri === undefined) {
                normalizedURI = new URI(`-${schemaInputs.size + 1}`);
            } else {
                normalizedURI = new URI(uri).normalize();
            }

            if (schema === undefined) {
                assert(uri !== undefined, "URI must be given if schema source is not specified");
            } else {
                schemaInputs = schemaInputs.set(
                    normalizedURI
                        .clone()
                        .hash("")
                        .toString(),
                    schema
                );
            }

            schemaSources = schemaSources.push([normalizedURI, source]);
        }

        if (!schemaSources.isEmpty()) {
            if (schemaInputs.isEmpty()) {
                if (this._options.schemaStore === undefined) {
                    return panic("Must have a schema store to process JSON Schema");
                }
                this._schemaStore = this._options.schemaStore;
            } else {
                this._schemaStore = new InputJSONSchemaStore(schemaInputs, this._options.schemaStore);
            }

            await forEachSync(schemaSources, async ([normalizedURI, source]) => {
                const { name, topLevelRefs } = source;

                if (topLevelRefs !== undefined) {
                    assert(
                        topLevelRefs.length === 1 && topLevelRefs[0] === "/definitions/",
                        "Schema top level refs must be `/definitions/`"
                    );
                    const definitionRefs = await definitionRefsInSchema(
                        this.getSchemaStore(),
                        normalizedURI.toString()
                    );
                    definitionRefs.forEach((ref, refName) => {
                        this.addSchemaInput(refName, ref);
                    });
                } else {
                    this.addSchemaInput(name, Ref.parse(normalizedURI.toString()));
                }
            });
        }

        for (const source of this._options.sources) {
            if (isGraphQLSource(source)) {
                const { name, schema, query } = source;
                this._allInputs.graphQLs[name] = { schema, query: await toString(query) };
            } else if (isJSONSource(source)) {
                const { name, samples, description } = source;
                for (const sample of samples) {
                    const input = await this._compressedJSON.readFromStream(toReadable(sample));
                    if (!_.has(this._allInputs.samples, name)) {
                        this._allInputs.samples[name] = { samples: [] };
                    }
                    this._allInputs.samples[name].samples.push(input);
                    if (description !== undefined) {
                        this._allInputs.samples[name].description = description;
                    }
                }
            } else if (!isSchemaSource(source)) {
                assertNever(source);
            }
        }

        const graph = await this.makeGraph();

        if (this._options.noRender) {
            return this.makeSimpleTextResult(["Done.", ""]);
        }

        if (this._options.findSimilarClassesSchemaURI !== undefined) {
            const cliques = findSimilarityCliques(graph, true);
            const lines: string[] = [];
            if (cliques.length === 0) {
                lines.push("No similar classes found.");
            } else {
                for (let clique of cliques) {
                    lines.push(`similar: ${clique.map(c => c.getCombinedName()).join(", ")}`);
                }
            }
            lines.push("");
            return this.makeSimpleTextResult(lines);
        }

        if (this._options.handlebarsTemplate !== undefined) {
            return OrderedMap([
                [
                    this._options.outputFilename,
                    targetLanguage.processHandlebarsTemplate(
                        graph,
                        this._options.rendererOptions,
                        this._options.handlebarsTemplate
                    )
                ]
            ] as [string, SerializedRenderResult][]);
        } else {
            return targetLanguage.renderGraphAndSerialize(
                graph,
                this._options.outputFilename,
                this._options.alphabetizeProperties,
                this._options.leadingComments,
                this._options.rendererOptions,
                this._options.indentation
            );
        }
    };
}

export function quicktypeMultiFile(options: Partial<Options>): Promise<Map<string, SerializedRenderResult>> {
    return new Run(options).run();
}

function offsetLocation(loc: Location, lineOffset: number): Location {
    return { line: loc.line + lineOffset, column: loc.column };
}

function offsetSpan(span: Span, lineOffset: number): Span {
    return { start: offsetLocation(span.start, lineOffset), end: offsetLocation(span.end, lineOffset) };
}

export async function quicktype(options: Partial<Options>): Promise<SerializedRenderResult> {
    const result = await quicktypeMultiFile(options);
    if (result.size <= 1) {
        const first = result.first();
        if (first === undefined) {
            return { lines: [], annotations: List<Annotation>() };
        }
        return first;
    }
    let lines: string[] = [];
    let annotations: Annotation[] = [];
    result.forEach((srr, filename) => {
        const offset = lines.length + 2;
        lines = lines.concat([`// ${filename}`, ""], srr.lines);
        annotations = annotations.concat(
            srr.annotations.map(ann => ({ annotation: ann.annotation, span: offsetSpan(ann.span, offset) })).toArray()
        );
    });
    return { lines, annotations: List(annotations) };
}
