/** The general, externally accessible plugin API (available at `app.plugins.plugins.dataview.api`). */

import { App, Component } from "obsidian";
import { FullIndex } from "data-index/index";
import { matchingSourcePaths } from "data-index/resolver";
import { Sources } from "data-index/source";
import { DataObject, Grouping, Groupings, Link, Literal, Values } from "data-model/value";
import { EXPRESSION } from "expression/parse";
import { renderList, renderTable, renderValue } from "ui/render";
import { DataArray } from "./data-array";
import { BoundFunctionImpl, DEFAULT_FUNCTIONS, Functions } from "expression/functions";
import { Context } from "expression/context";
import { defaultLinkHandler } from "query/engine";
import { DateTime, Duration } from "luxon";
import * as Luxon from "luxon";
import { compare, CompareOperator, satisfies } from "compare-versions";
import { DvAPIInterface, DvIOAPIInterface } from "../typings/api";
import { DataviewSettings } from "settings";
import { parseFrontmatter } from "data-import/markdown-file";
import { SListItem } from "data-model/serialized/markdown";
import { createFixedTaskView } from "ui/views/task-view";

/** Asynchronous API calls related to file / system IO. */
export class DataviewIOApi implements DvIOAPIInterface {
    public constructor(public api: DataviewApi) {}

    /** Load the contents of a CSV asynchronously, returning a data array of rows (or undefined if it does not exist). */
    public async csv(path: Link | string, originFile?: string): Promise<DataArray<DataObject> | undefined> {
        if (!Values.isLink(path) && !Values.isString(path)) {
            throw Error(`dv.io.csv only handles string or link paths; was provided type '${typeof path}'.`);
        }

        let data = await this.api.index.csv.get(this.normalize(path, originFile));
        if (data.successful) return DataArray.from(data.value, this.api.settings);
        else throw Error(`Could not find CSV for path '${path}' (relative to origin '${originFile ?? "/"}')`);
    }

    /** Asynchronously load the contents of any link or path in an Obsidian vault. */
    public async load(path: Link | string, originFile?: string): Promise<string | undefined> {
        if (!Values.isLink(path) && !Values.isString(path)) {
            throw Error(`dv.io.load only handles string or link paths; was provided type '${typeof path}'.`);
        }

        return this.api.index.vault.adapter.read(this.normalize(path, originFile));
    }

    /** Normalize a link or path relative to an optional origin file. Returns a textual fully-qualified-path. */
    public normalize(path: Link | string, originFile?: string): string {
        let realPath;
        if (Values.isLink(path)) realPath = path.path;
        else realPath = path;

        return this.api.index.prefix.resolveRelative(realPath, originFile);
    }
}

export class DataviewApi implements DvAPIInterface {
    /** Evaluation context which expressions can be evaluated in. */
    public evaluationContext: Context;
    public io: DataviewIOApi;
    /** Dataview functions which can be called from DataviewJS. */
    public func: Record<string, BoundFunctionImpl>;
    /** Value utility functions for comparisons and type-checking. */
    public value = Values;
    /** Re-exporting of luxon for people who can't easily require it. Sorry! */
    public luxon = Luxon;

    public constructor(
        public app: App,
        public index: FullIndex,
        public settings: DataviewSettings,
        private verNum: string
    ) {
        this.evaluationContext = new Context(defaultLinkHandler(index, ""), settings);
        this.func = Functions.bindAll(DEFAULT_FUNCTIONS, this.evaluationContext);
        this.io = new DataviewIOApi(this);
    }

    /** utils to check api version */
    public version: DvAPIInterface["version"] = (() => {
        const { verNum: version } = this;
        return {
            get current() {
                return version;
            },
            compare: (op: CompareOperator, ver: string) => compare(version, ver, op),
            satisfies: (range: string) => satisfies(version, range),
        };
    })();

    /////////////////////////////
    // Index + Data Collection //
    /////////////////////////////

    /** Return an array of paths (as strings) corresponding to pages which match the query. */
    public pagePaths(query?: string, originFile?: string): DataArray<string> {
        let source;
        try {
            if (!query || query.trim() === "") source = Sources.folder("");
            else source = EXPRESSION.source.tryParse(query);
        } catch (ex) {
            throw new Error(`Failed to parse query in 'pagePaths': ${ex}`);
        }

        return matchingSourcePaths(source, this.index, originFile)
            .map(s => DataArray.from(s, this.settings))
            .orElseThrow();
    }

    /** Map a page path to the actual data contained within that page. */
    public page(path: string | Link, originFile?: string): Record<string, Literal> | undefined {
        if (!(typeof path === "string") && !Values.isLink(path)) {
            throw Error("dv.page only handles string and link paths; was provided type '" + typeof path + "'");
        }

        let rawPath = path instanceof Link ? path.path : path;
        let normPath = this.app.metadataCache.getFirstLinkpathDest(rawPath, originFile ?? "");
        if (!normPath) return undefined;

        let pageObject = this.index.pages.get(normPath.path);
        if (!pageObject) return undefined;

        return DataArray.convert(pageObject.serialize(this.index), this.settings);
    }

    /** Return an array of page objects corresponding to pages which match the query. */
    public pages(query?: string, originFile?: string): DataArray<Record<string, Literal>> {
        return this.pagePaths(query, originFile).flatMap(p => {
            let res = this.page(p, originFile);
            return res ? [res] : [];
        });
    }

    /////////////
    // Utility //
    /////////////

    /**
     * Convert an input element or array into a Dataview data-array. If the input is already a data array,
     * it is returned unchanged.
     */
    public array(raw: unknown): DataArray<any> {
        if (DataArray.isDataArray(raw)) return raw;
        if (Array.isArray(raw)) return DataArray.wrap(raw, this.settings);
        return DataArray.wrap([raw], this.settings);
    }

    /** Return true if theg given value is a javascript array OR a dataview data array. */
    public isArray(raw: unknown): raw is DataArray<any> | Array<any> {
        return DataArray.isDataArray(raw) || Array.isArray(raw);
    }

    /** Create a dataview file link to the given path. */
    public fileLink(path: string, embed: boolean = false, display?: string) {
        return Link.file(path, embed, display);
    }

    /** Attempt to extract a date from a string, link or date. */
    public date(pathlike: string | Link | DateTime): DateTime | null {
        return this.func.date(pathlike) as DateTime | null;
    }

    /** Attempt to extract a duration from a string or duration. */
    public duration(str: string | Duration): Duration | null {
        return this.func.dur(str) as Duration | null;
    }

    /** Parse a raw textual value into a complex Dataview type, if possible. */
    public parse(value: string): Literal {
        let raw = EXPRESSION.inlineField.parse(value);
        if (raw.status) return raw.value;
        else return value;
    }

    /** Convert a basic JS type into a Dataview type by parsing dates, links, durations, and so on. */
    public literal(value: any): Literal {
        return DataArray.convert(parseFrontmatter(value), this.settings);
    }

    /**
     * Compare two arbitrary JavaScript values using Dataview's default comparison rules. Returns a negative value if
     * a < b, 0 if a = b, and a positive value if a > b.
     */
    public compare(a: any, b: any): number {
        return Values.compareValue(a, b);
    }

    /** Return true if the two given JavaScript values are equal using Dataview's default comparison rules. */
    public equal(a: any, b: any): boolean {
        return this.compare(a, b) == 0;
    }

    ///////////////
    // Rendering //
    ///////////////

    /** Render a dataview list of the given values. */
    public async list(
        values: any[] | DataArray<any> | undefined,
        container: HTMLElement,
        component: Component,
        filePath: string
    ) {
        if (!values) return;

        await renderList(container, values as any[], component, filePath, this.settings);
    }

    /** Render a dataview table with the given headers, and the 2D array of values. */
    public async table(
        headers: string[],
        values: any[][] | DataArray<any> | undefined,
        container: HTMLElement,
        component: Component,
        filePath: string
    ) {
        if (!values) values = [];
        await renderTable(container, headers, values as any[][], component, filePath, this.settings);
    }

    /** Render a dataview task view with the given tasks. */
    public async taskList(
        tasks: Grouping<SListItem>,
        groupByFile: boolean = true,
        container: HTMLElement,
        component: Component,
        filePath: string = ""
    ) {
        let groupedTasks =
            !Groupings.isGrouping(tasks) && groupByFile ? this.array(tasks).groupBy(t => Link.file(t.path)) : tasks;
        component.addChild(
            createFixedTaskView(
                this.app,
                this.settings,
                this.index,
                container,
                groupedTasks as Grouping<SListItem>,
                filePath
            )
        );
    }

    /** Render an arbitrary value into a container. */
    public async renderValue(
        value: any,
        container: HTMLElement,
        component: Component,
        filePath: string,
        inline: boolean = false
    ) {
        await renderValue(value as Literal, container, filePath, component, this.settings, inline);
    }
}
