import { setInlineField } from "data-import/inline-field";
import { LIST_ITEM_REGEX } from "data-import/markdown-file";
import { FullIndex } from "data-index";
import { SListEntry, SListItem, STask } from "data-model/serialized/markdown";
import { Grouping, Groupings } from "data-model/value";
import { DateTime } from "luxon";
import { App, MarkdownRenderChild, Vault } from "obsidian";
import { Fragment, h } from "preact";
import { useContext } from "preact/hooks";
import { executeTask } from "query/engine";
import { Query } from "query/query";
import { DataviewSettings } from "settings";
import {
    DataviewContext,
    ErrorPre,
    ErrorMessage,
    Lit,
    Markdown,
    ReactRenderer,
    useIndexBackedState,
} from "ui/markdown";
import { asyncTryOrPropogate } from "util/normalize";

/** JSX component which renders a task element recursively. */
function TaskItem({ item }: { item: STask }) {
    let context = useContext(DataviewContext);

    // Navigate to the given task on click.
    const onClicked = (evt: preact.JSX.TargetedMouseEvent<HTMLElement>) => {
        const selectionState = { eState: { cursor: { from: { line: item.line }, to: { line: item.line } } } };
        context.app.workspace.openLinkText(item.path, item.path, evt.shiftKey, selectionState as any);
    };

    // Check/uncheck trhe task in the original file.
    const onChecked = (evt: preact.JSX.TargetedEvent<HTMLInputElement>) => {
        const completed = evt.currentTarget.checked;
        let updatedText = undefined;
        if (context.settings.taskCompletionTracking)
            updatedText = setTaskCompletion(item.text, context.settings.taskCompletionText, completed);

        rewriteTask(context.app.vault, item, completed ? "X" : " ", updatedText);
    };

    return (
        <li class={"dataview task-list-item" + (item.completed ? " is-checked" : "")}>
            <input
                style="margin-right: 6px;"
                class="task-list-item-checkbox"
                type="checkbox"
                checked={item.completed}
                onClick={onChecked}
            />
            <Markdown onClick={onClicked} content={item.text} sourcePath={item.path} />
            {item.children.length > 0 && <TaskList items={item.children} />}
        </li>
    );
}

/** JSX component which renders a plain list item recursively. */
function ListItem({ item }: { item: SListEntry }) {
    return (
        <li class="dataview task-list-basic-item">
            <Markdown content={item.text} sourcePath={item.path} />
            {item.children.length > 0 && <TaskList items={item.children} />}
        </li>
    );
}

/** JSX component which renders a list of task items recursively. */
function TaskList({ items }: { items: SListItem[] }) {
    const settings = useContext(DataviewContext).settings;
    if (items.length == 0 && settings.warnOnEmptyResult)
        return <ErrorMessage message="Dataview: No results to show." />;

    let [nest, _mask] = nestItems(items);
    return (
        <ul class="contains-task-list">
            {nest.map(item => (item.task ? <TaskItem item={item} /> : <ListItem item={item} />))}
        </ul>
    );
}

/** JSX component which recursively renders grouped tasks. */
function TaskGrouping({ items, sourcePath }: { items: Grouping<SListItem>; sourcePath: string }) {
    const isGrouping = items.length > 0 && Groupings.isGrouping(items);

    return (
        <Fragment>
            {isGrouping &&
                items.map(item => (
                    <Fragment>
                        <h4>
                            <Lit value={item.key} sourcePath={sourcePath} />
                        </h4>
                        <div class="dataview result-group">
                            <TaskGrouping items={item.rows} sourcePath={sourcePath} />
                        </div>
                    </Fragment>
                ))}
            {!isGrouping && <TaskList items={items as SListItem[]} />}
        </Fragment>
    );
}

export type TaskViewState =
    | { state: "loading" }
    | { state: "error"; error: string }
    | { state: "ready"; items: Grouping<SListItem> };

/**
 * Pure view over (potentially grouped) tasks and list items which allows for checking/unchecking tasks and manipulating
 * the task view.
 */
export function TaskView({ query, sourcePath }: { query: Query; sourcePath: string }) {
    let context = useContext(DataviewContext);

    let items = useIndexBackedState<TaskViewState>(
        context.container,
        context.app,
        context.settings,
        context.index,
        { state: "loading" },
        async () => {
            let result = await asyncTryOrPropogate(() =>
                executeTask(query, sourcePath, context.index, context.settings)
            );
            if (!result.successful) return { state: "error", error: result.error, sourcePath };
            else return { state: "ready", items: result.value.tasks };
        }
    );

    if (items.state == "loading")
        return (
            <Fragment>
                <ErrorPre>Loading</ErrorPre>
            </Fragment>
        );
    else if (items.state == "error")
        return (
            <Fragment>
                <ErrorPre>Dataview: {items.error}</ErrorPre>
            </Fragment>
        );

    return <TaskGrouping items={items.items} sourcePath={sourcePath} />;
}

export function createTaskView(
    app: App,
    settings: DataviewSettings,
    index: FullIndex,
    container: HTMLElement,
    query: Query,
    sourcePath: string
): MarkdownRenderChild {
    return new ReactRenderer(app, settings, index, container, <TaskView query={query} sourcePath={sourcePath} />);
}

export function createFixedTaskView(
    app: App,
    settings: DataviewSettings,
    index: FullIndex,
    container: HTMLElement,
    items: Grouping<SListItem>,
    sourcePath: string
): MarkdownRenderChild {
    return new ReactRenderer(app, settings, index, container, <TaskGrouping items={items} sourcePath={sourcePath} />);
}

/////////////////////////
// Task De-Duplication //
/////////////////////////

function listId(item: SListItem): string {
    return item.path + ":" + item.line;
}

/** Compute the line numbers of all children of the given list item. */
function listChildren(item: SListItem, output?: Set<string>): Set<string> {
    if (!output) output = new Set();

    for (let child of item.children) {
        output.add(listId(child));
        listChildren(child, output);
    }

    return output;
}

/** Removes tasks from a list if they are already present by being a child of another task. */
export function nestItems(raw: SListItem[]): [SListItem[], Set<string>] {
    let seen: Set<string> = new Set();
    let mask: Set<string> = new Set();
    for (let item of raw) {
        listChildren(item, seen);
        mask.add(listId(item));
    }

    return [raw.filter(t => !seen.has(listId(t))), mask];
}

///////////////////////
// Task Manipulation //
///////////////////////

/** Trim empty ending lines. */
function trimEndingLines(text: string): string {
    let parts = text.split(/\r?\n/u);
    let trim = parts.length - 1;
    while (trim > 0 && parts[trim].trim() == "") trim--;

    return parts.join("\n");
}

/** Set the task completion key on check. */
export function setTaskCompletion(originalText: string, completionKey: string, complete: boolean): string {
    if (!complete) return trimEndingLines(setInlineField(originalText, completionKey, undefined));

    let parts = originalText.split(/\r?\n/u);
    parts[parts.length - 1] = setInlineField(parts[parts.length - 1], completionKey, DateTime.now().toISODate());
    return parts.join("\n");
}

/** Rewrite a task with the given completion status and new text. */
export async function rewriteTask(vault: Vault, task: STask, desiredStatus: string, desiredText?: string) {
    if (desiredStatus == task.status && (desiredText == undefined || desiredText == task.text)) return;
    desiredStatus = desiredStatus == "" ? " " : desiredStatus;

    let rawFiletext = await vault.adapter.read(task.path);
    let hasRN = rawFiletext.contains("\r");
    let filetext = rawFiletext.split(/\r?\n/u);

    if (filetext.length < task.line) return;
    let match = LIST_ITEM_REGEX.exec(filetext[task.line]);
    if (!match || match[2].length == 0) return;

    let taskTextParts = task.text.split("\n");
    if (taskTextParts[0].trim() != match[3].trim()) return;

    // We have a positive match here at this point, so go ahead and do the rewrite of the status.
    let initialSpacing = /^\s*/u.exec(filetext[task.line])!![0];
    if (desiredText) {
        let desiredParts = desiredText.split("\n");

        let newTextLines: string[] = [`${initialSpacing}${task.symbol} [${desiredStatus}] ${desiredParts[0]}`].concat(
            desiredParts.slice(1).map(l => initialSpacing + "\t" + l)
        );

        filetext.splice(task.line, task.lineCount, ...newTextLines);
    } else {
        filetext[task.line] = `${initialSpacing}${task.symbol} [${desiredStatus}] ${taskTextParts[0].trim()}`;
    }

    let newText = filetext.join(hasRN ? "\r\n" : "\n");
    await vault.adapter.write(task.path, newText);
}
