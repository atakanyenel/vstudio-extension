import * as _ from 'lodash';
import * as vscode from 'vscode';
import { yamlLocator, YamlMap } from "./yaml-locator";
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import {
    VSCODE_YAML_EXTENSION_ID, KUBERNETES_SCHEMA, KUBERNETES_GROUP_VERSION_KIND, GROUP_VERSION_KIND_SEPARATOR,
    KUBERNETES_SCHEMA_FILE, KUBERNETES_SCHEMA_ENUM_FILE
} from "./yaml-constant";
import * as util from "./yaml-util";
import { formatComplex, formatOne, formatType } from '../schema-formatting';

export interface KubernetesSchema {
    readonly name: string;
    readonly description?: string;
    readonly id?: string;
    readonly apiVersion?: string;
    readonly kind?: string;
    readonly 'x-kubernetes-group-version-kind'?: any[];
    readonly properties?: { [key: string]: any; };
}

// The function signature exposed by vscode-yaml:
// 1. the requestSchema api will be called by vscode-yaml extension to decide whether the schema can be handled by this
// contributor, if it returns undefined, means it doesn't support this yaml file, vscode-yaml will ask other contributors
// 2. the requestSchemaContent api  will give the parameter uri returned by the first api, and ask for the json content(after stringify) of
// the schema
declare type YamlSchemaContributor = (schema: string,
    requestSchema: (resource: string) => string,
    requestSchemaContent: (uri: string) => string) => void;
const PORT = vscode.workspace.getConfiguration("vs-kyma")["kyma.schema-server-port"];
class KubernetesSchemaHolder {
    // the schema for kubernetes
    private _definitions: { [key: string]: KubernetesSchema; } = {};

    private _schemaEnums: { [key: string]: { [key: string]: [string[]] }; };

    // load the kubernetes schema and make some modifications to $ref node
    public loadSchema(schemaFile: string, schemaEnumFile?: string): void {
        const schemaRaw = util.loadJson(schemaFile);
        this._schemaEnums = schemaEnumFile ? util.loadJson(schemaEnumFile) : {};
        const definitions = schemaRaw.definitions;
        for (const name of Object.keys(definitions)) {
            this.saveSchemaWithManifestStyleKeys(name, definitions[name]);
        }

        for (const schema of _.values(this._definitions)) {
            if (schema.properties) {
                // the swagger schema has very short description on properties, we need to get the actual type of
                // the property and provide more description/properties details, just like `kubernetes explain` do.
                _.each(schema.properties, (propVal, propKey) => {
                    if (schema.kind && propKey === 'kind') {
                        propVal.markdownDescription = this.getMarkdownDescription(schema.kind, undefined, schema, true);
                        return;
                    }

                    const currentPropertyTypeRef = propVal.$ref || (propVal.items ? propVal.items.$ref : undefined);
                    if (_.isString(currentPropertyTypeRef)) {
                        const id = getNameInDefinitions(currentPropertyTypeRef);
                        const propSchema = this.lookup(id);
                        if (propSchema) {
                            propVal.markdownDescription = this.getMarkdownDescription(propKey, propVal, propSchema);
                        }
                    } else {
                        propVal.markdownDescription = this.getMarkdownDescription(propKey, propVal, undefined);
                    }
                });

                // fix on each node in properties for $ref since it will directly reference '#/definitions/...'
                // we need to convert it into schema like 'kubernetes://schema/...'
                // we need also an array to collect them since we need to get schema from _definitions, at this point, we have
                // not finished the process of add schemas to _definitions, call patchOnRef will fail for some cases.
                this.replaceDefinitionRefsWithYamlSchemaUris(schema.properties);
                this.loadEnumsForKubernetesSchema(schema);
            }
        }
    }

    // get kubernetes schema by the key
    public lookup(key: string): KubernetesSchema {
        return key ? this._definitions[key.toLowerCase()] : undefined;
    }

    /**
     * Save the schema object in swagger json to schema map.
     *
     * @param {string} name the property name in definition node of swagger json
     * @param originalSchema the origin schema object in swagger json
     */
    private saveSchemaWithManifestStyleKeys(name: string, originalSchema: any): void {
        if (isGroupVersionKindStyle(originalSchema)) {
            // if the schema contains 'x-kubernetes-group-version-kind'. then it is a direct kubernetes manifest,
            getManifestStyleSchemas(originalSchema).forEach((schema: KubernetesSchema) => {
                this.saveSchema({
                    name,
                    ...schema
                });
            });

        } else {
            // if x-kubernetes-group-version-kind cannot be found, then it is an in-direct schema refereed by
            // direct kubernetes manifest, eg: io.k8s.kubernetes.pkg.api.v1.PodSpec
            this.saveSchema({
                name,
                ...originalSchema
            });
        }
    }

    // replace schema $ref with values like 'kubernetes://schema/...'
    private replaceDefinitionRefsWithYamlSchemaUris(node: any): void {
        if (!node) {
            return;
        }
        if (_.isArray(node)) {
            for (const subItem of <any[]>node) {
                this.replaceDefinitionRefsWithYamlSchemaUris(subItem);
            }
        }
        if (!_.isObject(node)) {
            return;
        }
        for (const key of Object.keys(node)) {
            this.replaceDefinitionRefsWithYamlSchemaUris(node[key]);
        }

        if (_.isString(node.$ref)) {
            const name = getNameInDefinitions(node.$ref);
            const schema = this.lookup(name);
            if (schema) {
                // replacing $ref
                node.$ref = util.makeKubernetesUri(schema.name);
            }
        }
    }

    // add enum field for pre-defined enums in schema-enums json file
    private loadEnumsForKubernetesSchema(node: KubernetesSchema) {
        if (node.properties && this._schemaEnums[node.name]) {
            _.each(node.properties, (propSchema, propKey) => {
                if (this._schemaEnums[node.name][propKey]) {
                    propSchema.enum = this._schemaEnums[node.name][propKey];
                }
            });
        }
    }

    // save the schema to the _definitions
    private saveSchema(schema: KubernetesSchema): void {
        if (schema.name) {
            this._definitions[schema.name.toLowerCase()] = schema;
        }
        if (schema.id) {
            this._definitions[schema.id.toLowerCase()] = schema;
        }
    }

    // get the markdown format of document for the current property and the type of current property
    private getMarkdownDescription(currentPropertyName: string, currentProperty: any, targetSchema: any, isKind = false): string {
        if (isKind) {
            return formatComplex(currentPropertyName, targetSchema.description, undefined, targetSchema.properties);
        }
        if (!targetSchema) {
            return formatOne(currentPropertyName, formatType(currentProperty), currentProperty.description);
        }
        const properties = targetSchema.properties;
        if (properties) {
            return formatComplex(currentPropertyName, currentProperty ? currentProperty.description : "",
                targetSchema.description, properties);
        }
        return currentProperty ? currentProperty.description : (targetSchema ? targetSchema.description : "");
    }
}

const kubeSchema: KubernetesSchemaHolder = new KubernetesSchemaHolder();



function startSchemaServer() {
    const apiSchema = fs.readFileSync(path.join(__dirname, "./../../../schema/api-schema.json"));
    const kubelessSchema = fs.readFileSync(path.join(__dirname, "./../../../schema/kubeless-schema.json"));
    const servicecatalogschema = fs.readFileSync(path.join(__dirname, "./../../../schema/servicecatalog-schema.json"));
    const remoteEnvSchema = fs.readFileSync(path.join(__dirname, "./../../../schema/remoteenv-schema.json"));
    http.createServer((req, res) => {
        const query = url.parse(req.url, true).query;
        switch (query.schema) {
            case "api":
                res.write(apiSchema);
                res.end();
                break;
            case "sc":
                res.write(servicecatalogschema);
                res.end();
                break;
            case "kubeless":
                res.write(kubelessSchema);
                res.end();
                break;
            case "re":
                res.write(remoteEnvSchema);
                res.end();
                break;

        }

    }).listen(PORT);
    console.log(PORT);
}
export async function registerYamlSchemaSupport(): Promise<void> {
    startSchemaServer();
    kubeSchema.loadSchema(KUBERNETES_SCHEMA_FILE, KUBERNETES_SCHEMA_ENUM_FILE);
    const yamlPlugin: any = await activateYamlExtension();
    if (!yamlPlugin || !yamlPlugin.registerContributor) {
        // activateYamlExtension has already alerted to users for errors.
        return;
    }
    // register for kubernetes schema provider
    // yamlPlugin.registerContributor(KUBERNETES_SCHEMA, requestYamlSchemaUriCallback, requestYamlSchemaContentCallback);
    yamlPlugin.registerContributor("kyma", getKymaUrl, (uri: string) => { console.log(uri); });
    console.log(yamlPlugin);
}



function getKymaUrl(resource: string): string {
    console.log(resource);
    const textEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === resource);
    if (textEditor) {
        const yamlDocs = yamlLocator.getYamlDocuments(textEditor.document);
        const choices: string[] = [];
        let url: string;
        yamlDocs.forEach((doc) => {
            // if the yaml document contains apiVersion and kind node, it will report it is a kubernetes yaml
            // file
            const topLevelMapping = <YamlMap>doc.nodes.find((node) => node.kind === 'MAPPING');
            if (topLevelMapping) {
                // if the overall yaml is an map, find the apiVersion and kind properties in yaml
                const apiVersion = util.getYamlMappingValue(topLevelMapping, 'apiVersion');

                if (apiVersion) {
                    if (apiVersion === "gateway.kyma.cx/v1alpha2") {
                        console.log("api");
                        url = `http://localhost:${PORT}/?schema=api`;
                    }
                    else if (apiVersion === "kubeless.io/v1beta1") {
                        console.log("kubeless");
                        url = `http://localhost:${PORT}/?schema=kubeless`;
                    }
                    else if (apiVersion === "servicecatalog.kyma.cx/v1alpha1") {
                        console.log("service catalog");
                        url = `http://localhost:${PORT}/?schema=sc`;
                    }
                    else if (apiVersion === "remoteenvironment.kyma.cx/v1alpha1") {
                        console.log("service catalog");
                        url = `http://localhost:${PORT}/?schema=re`;

                    }
                }
            }
        });

        return url;
    }
}


/**
 * Tell whether or not the swagger schema is a kubernetes manifest schema, a kubernetes manifest schema like Service
 * should have `x-kubernetes-group-version-kind` node.
 *
 * @param originalSchema the origin schema object in swagger json
 * @return whether or not the swagger schema is
 */
function isGroupVersionKindStyle(originalSchema: any): boolean {
    return originalSchema[KUBERNETES_GROUP_VERSION_KIND] && originalSchema[KUBERNETES_GROUP_VERSION_KIND].length;
}

/**
 * Process on kubernetes manifest schemas, for each selector in x-kubernetes-group-version-kind,
 * extract apiVersion and kind and make a id composed by apiVersion and kind.
 *
 * @param originalSchema the origin schema object in swagger json
 * @returns {KubernetesSchema[]} an array of schemas for the same manifest differentiated by id/apiVersion/kind;
 */
function getManifestStyleSchemas(originalSchema: any): KubernetesSchema[] {
    const schemas = [];
    // eg: service, pod, deployment
    const groupKindNode = originalSchema[KUBERNETES_GROUP_VERSION_KIND];

    // delete 'x-kubernetes-group-version-kind' since it is not a schema standard, it is only a selector
    delete originalSchema[KUBERNETES_GROUP_VERSION_KIND];

    groupKindNode.forEach((groupKindNode) => {
        const { id, apiVersion, kind } = util.parseKubernetesGroupVersionKind(groupKindNode);

        // a direct kubernetes manifest has two reference keys: id && name
        // id: apiVersion + kind
        // name: the name in 'definitions' of schema
        schemas.push({
            id,
            apiVersion,
            kind,
            ...originalSchema
        });
    });
    return schemas;
}


// convert '#/definitions/com.github.openshift.origin.pkg.build.apis.build.v1.ImageLabel' to
// 'com.github.openshift.origin.pkg.build.apis.build.v1.ImageLabel'
function getNameInDefinitions($ref: string): string {
    const prefix = '#/definitions/';
    if ($ref.startsWith(prefix)) {
        return $ref.slice(prefix.length);
    } else {
        return prefix;
    }
}


// find redhat.vscode-yaml extension and try to activate it to get the yaml contributor
async function activateYamlExtension(): Promise<{ registerContributor: YamlSchemaContributor }> {
    const ext: vscode.Extension<any> = vscode.extensions.getExtension(VSCODE_YAML_EXTENSION_ID);
    if (!ext) {
        vscode.window.showWarningMessage('Please install \'YAML Support by Red Hat\' via the Extensions pane.');
        return;
    }
    const yamlPlugin = await ext.activate();

    if (!yamlPlugin || !yamlPlugin.registerContributor) {
        vscode.window.showWarningMessage('The installed Red Hat YAML extension doesn\'t support Kubernetes Intellisense. Please upgrade \'YAML Support by Red Hat\' via the Extensions pane.');
        return;
    }
    return yamlPlugin;
}
