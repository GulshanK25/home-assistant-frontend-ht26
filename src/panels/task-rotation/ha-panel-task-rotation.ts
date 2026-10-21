/** Task Rotation: a Counter-backed household task demonstration. */
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators";
import type { HomeAssistant } from "../../types";

const TODO_ENTITY = "todo.household_task";
const META_START = "[task-rotation:v1]";
const META_END = "[/task-rotation]";

interface TodoItem {
  uid?: string;
  summary: string;
  description?: string;
  due?: string;
}
type RotationMode = "manual" | "timer" | "timer_schedule";

interface Rotation {
  people: string[];
  index: number;
  completed: number;
  counter_entity?: string;
  counter_id?: string;
}

function parseDescription(description = ""): {
  notes: string;
  rotation?: Rotation;
  invalid?: boolean;
} {
  const start = description.indexOf(META_START);
  const end = description.indexOf(META_END, start + META_START.length);
  if (start < 0 || end < 0) {
    return { notes: description };
  }
  const notes = (
    description.slice(0, start) + description.slice(end + META_END.length)
  ).trim();
  try {
    const data: Rotation = JSON.parse(
      description.slice(start + META_START.length, end)
    );
    if (
      !Array.isArray(data.people) ||
      !data.people.length ||
      !data.people.every((name) => typeof name === "string" && name.trim()) ||
      !Number.isInteger(data.index) ||
      !Number.isInteger(data.completed)
    ) {
      throw new Error("Invalid rotation metadata");
    }
    return { notes, rotation: data };
  } catch (_error) {
    return { notes, invalid: true };
  }
}

function serializeRotation(notes: string, rotation: Rotation): string {
  return [notes.trim(), `${META_START}${JSON.stringify(rotation)}${META_END}`]
    .filter(Boolean)
    .join("\n\n");
}

function namesFromInput(value: string): string[] {
  const people = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (
    !people.length ||
    people.length > 12 ||
    people.some((name) => name.length > 60) ||
    new Set(people.map((name) => name.toLowerCase())).size !== people.length
  ) {
    throw new Error(
      "Enter 1–12 distinct participant names, separated by commas."
    );
  }
  return people;
}

@customElement("ha-panel-task-rotation")
export class HaPanelTaskRotation extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ type: Boolean }) public narrow = false;

  @state() private _items: TodoItem[] = [];
  @state() private _loading = false;
  @state() private _busy = false;
  @state() private _notice = "";
  @state() private _createOpen = false;
  @state() private _name = "";
  @state() private _due = "";
  @state() private _people = "";
  @state() private _rotationMode: RotationMode = "manual";
  @state() private _timerEntity = "";
  @state() private _scheduleEntity = "";
  @state() private _editId: string | null = null;
  @state() private _editPeople = "";

  protected firstUpdated(): void {
    void this._load();
  }

  private _itemId(item: TodoItem): string {
    return item.uid || item.summary;
  }

  private _counterState(entityId: string) {
    return this.hass.states[entityId];
  }

  private _counterMatches(entityId: string, numPeople: number): boolean {
    const counterState = this._counterState(entityId);
    return Boolean(
      counterState &&
      counterState.attributes.minimum === 1 &&
      counterState.attributes.maximum === numPeople &&
      counterState.attributes.step === 1 &&
      Number.isInteger(Number(counterState.state)) &&
      Number(counterState.state) >= 1 &&
      Number(counterState.state) <= numPeople
    );
  }

  private _assignedIndex(rotation: Rotation): number {
    if (rotation.counter_entity) {
      const entityId = rotation.counter_entity;
      const value = Number(this._counterState(entityId)?.state);
      return this._counterMatches(entityId, rotation.people.length)
        ? value - 1
        : -1;
    }
    return (
      ((rotation.index % rotation.people.length) + rotation.people.length) %
      rotation.people.length
    );
  }

  private _completedTurns(rotation: Rotation): number {
    // Confirmed manual completions stay in To-do metadata. Timer completions
    // are tracked by Core so they count even while this panel is closed.
    if (!rotation.counter_entity) return rotation.completed;
    const count = this._counterState(rotation.counter_entity)?.attributes
      .automatic_turns;
    const automaticTurns =
      typeof count === "number" && Number.isSafeInteger(count) && count >= 0
        ? count
        : 0;
    return rotation.completed + automaticTurns;
  }

  private _helperEntities(domain: string): string[] {
    return Object.keys(this.hass?.states ?? {})
      .filter((entityId) => entityId.startsWith(`${domain}.`))
      .sort();
  }

  private async _createCounter(
    name: string,
    peopleCount: number,
    timerEntity = "",
    scheduleEntity = ""
  ): Promise<{ id: string; entityId: string }> {
    // Counter names are not necessarily unique. Core assigns a unique ID.
    const config = {
      type: "counter/create",
      name: `${name} rotation`,
      initial: 1,
      minimum: 1,
      maximum: peopleCount,
      step: 1,
      restore: true,
      enhanced_mode: true,
      ...(timerEntity ? { timer_entity: timerEntity } : {}),
      ...(scheduleEntity ? { schedule_entity: scheduleEntity } : {}),
    };

    const created = await this.hass.callWS<{ id: string }>(config);
    if (!created?.id) {
      throw new Error("Home Assistant did not return a Counter ID.");
    }
    return { id: created.id, entityId: `counter.${created.id}` };
  }

  private async _resizeCounter(
    entityId: string,
    storedId: string | undefined,
    peopleCount: number,
    nextIndex: number
  ): Promise<void> {
    const items = await this.hass.callWS<Record<string, unknown>[]>({
      type: "counter/list",
    });
    const counterId = storedId ?? entityId.replace(/^counter\./, "");
    const existing = items.find((item) => item.id === counterId);
    if (!existing) {
      throw new Error(`Could not find Counter settings for ${entityId}`);
    }
    const settings = { ...existing };
    delete settings.id;
    await this.hass.callWS({
      type: "counter/update",
      counter_id: counterId,
      ...settings,
      minimum: 1,
      maximum: peopleCount,
      initial: 1,
      step: 1,
      enhanced_mode: true,
    });
    await this.hass.callService(
      "counter",
      "set_value",
      { value: nextIndex + 1 },
      { entity_id: entityId }
    );
  }

  private async _load(): Promise<void> {
    if (!this.hass || this._loading) return;
    this._loading = true;
    try {
      const response = (await this.hass.callService(
        "todo",
        "get_items",
        { status: "needs_action" },
        { entity_id: TODO_ENTITY },
        false,
        true
      )) as unknown as { response?: Record<string, { items?: TodoItem[] }> };
      const items = response.response?.[TODO_ENTITY]?.items;
      if (!Array.isArray(items)) {
        throw new Error("Could not read household tasks");
      }
      this._items = items;
    } catch (error) {
      this._notice = `Unable to load tasks: ${String(error)}`;
    } finally {
      this._loading = false;
    }
  }

  private async _create(event: Event): Promise<void> {
    event.preventDefault();
    if (this._busy) return;
    this._busy = true;
    let created: { id: string; entityId: string } | undefined;
    let todoSaved = false;
    try {
      const name = this._name.trim();
      if (!name) throw new Error("Task name is required.");
      const people = namesFromInput(this._people);
      const timerEntity =
        this._rotationMode === "manual" ? "" : this._timerEntity;
      const scheduleEntity =
        this._rotationMode === "timer_schedule" ? this._scheduleEntity : "";

      if (this._rotationMode !== "manual") {
        if (!timerEntity) {
          throw new Error("Select a Timer helper for automatic rotation.");
        }
        if (
          !timerEntity.startsWith("timer.") ||
          !this.hass.states[timerEntity]
        ) {
          throw new Error("Selected Timer helper no longer exists.");
        }
      }
      if (this._rotationMode === "timer_schedule") {
        if (!scheduleEntity) {
          throw new Error(
            "Select a Schedule helper to restrict automatic rotation."
          );
        }
        if (
          !scheduleEntity.startsWith("schedule.") ||
          !this.hass.states[scheduleEntity]
        ) {
          throw new Error("Selected Schedule helper no longer exists.");
        }
      }

      // Each task owns its own persistent Counter from the start.
      // Manual tasks intentionally omit both optional automation fields.
      created = await this._createCounter(
        name,
        people.length,
        timerEntity,
        scheduleEntity
      );
      const data: Record<string, string> = {
        item: name,
        description: serializeRotation("", {
          people,
          index: 0,
          completed: 0,
          counter_entity: created.entityId,
          counter_id: created.id,
        }),
      };
      if (this._due) data.due_date = this._due;
      await this.hass.callService("todo", "add_item", data, {
        entity_id: TODO_ENTITY,
      });
      todoSaved = true;
      this._createOpen = false;
      this._name = "";
      this._due = "";
      this._people = "";
      this._rotationMode = "manual";
      this._timerEntity = "";
      this._scheduleEntity = "";
      await this._load();
      this._notice = `Created ${name} with ${created.entityId}`;
    } catch (error) {
      // Avoid orphan Counters if the To-do task could not be saved.
      if (created && !todoSaved) {
        try {
          await this.hass.callWS({
            type: "counter/delete",
            counter_id: created.id,
          });
        } catch (cleanupError) {
          this._notice = `Creation failed: ${String(error)}. Cleanup also failed: ${String(cleanupError)}. Check for an unused Counter: ${created.entityId}`;
          this._busy = false;
          return;
        }
      }
      this._notice = `Could not create task: ${String(error)}`;
    } finally {
      this._busy = false;
    }
  }

  private async _saveRotation(
    item: TodoItem,
    rotation: Rotation,
    notice: string
  ): Promise<void> {
    const parsed = parseDescription(item.description);
    if (parsed.invalid) throw new Error("Task has invalid rotation metadata");
    await this.hass.callService(
      "todo",
      "update_item",
      {
        item: this._itemId(item),
        description: serializeRotation(parsed.notes, rotation),
      },
      { entity_id: TODO_ENTITY }
    );
    await this._load();
    this._notice = notice;
  }

  private async _assign(item: TodoItem): Promise<void> {
    if (this._busy) return;
    this._busy = true;
    try {
      const people = namesFromInput(this._editPeople);
      const parsed = parseDescription(item.description);
      if (parsed.invalid) throw new Error("Task has invalid rotation metadata");
      const existing = parsed.rotation;
      const currentIndex = existing ? this._assignedIndex(existing) : 0;
      const currentName =
        currentIndex >= 0 ? existing?.people[currentIndex] : undefined;
      const matchedIndex = currentName ? people.indexOf(currentName) : -1;
      const index = matchedIndex < 0 ? 0 : matchedIndex;
      let counterEntity = existing?.counter_entity;
      let counterId = existing?.counter_id;
      let newlyCreatedCounter = false;
      if (!counterEntity) {
        // Convert previously created prototype tasks automatically.
        const created = await this._createCounter(item.summary, people.length);
        counterEntity = created.entityId;
        counterId = created.id;
        newlyCreatedCounter = true;
        // Preserve the assignee selected by the previous local rotation.
        if (index > 0) {
          try {
            await this.hass.callService(
              "counter",
              "set_value",
              { value: index + 1 },
              { entity_id: counterEntity }
            );
          } catch (error) {
            await this.hass.callWS({
              type: "counter/delete",
              counter_id: created.id,
            });
            throw error;
          }
        }
      } else if (existing?.people.length !== people.length) {
        await this._resizeCounter(
          counterEntity,
          counterId,
          people.length,
          index
        );
      } else if (index !== currentIndex) {
        await this.hass.callService(
          "counter",
          "set_value",
          { value: index + 1 },
          { entity_id: counterEntity }
        );
      }
      try {
        await this._saveRotation(
          item,
          {
            people,
            index,
            completed: existing?.completed ?? 0,
            counter_entity: counterEntity,
            counter_id: counterId,
          },
          `Participants saved; using ${counterEntity}`
        );
      } catch (saveError) {
        if (newlyCreatedCounter && counterId) {
          try {
            await this.hass.callWS({
              type: "counter/delete",
              counter_id: counterId,
            });
          } catch (cleanupError) {
            this._notice = `Unused Counter cleanup failed: ${String(cleanupError)}`;
          }
        }
        throw saveError;
      }
      this._editId = null;
    } catch (error) {
      this._notice = `Could not save participants: ${String(error)}`;
    } finally {
      this._busy = false;
    }
  }

  private async _complete(item: TodoItem, rotation: Rotation): Promise<void> {
    if (this._busy) return;
    this._busy = true;
    try {
      if (rotation.counter_entity) {
        if (
          !this._counterMatches(rotation.counter_entity, rotation.people.length)
        ) {
          throw new Error("Counter settings no longer match participants.");
        }
        // The Counter is authoritative: it advances and wraps in Core.
        await this.hass.callService(
          "counter",
          "increment",
          {},
          {
            entity_id: rotation.counter_entity,
          }
        );
        // Only the completed-turn count is stored in the To-do description.
        // If this write fails, the Counter has still advanced. Don't retry
        // this action blindly or it will advance a second time.
        await this._saveRotation(
          item,
          { ...rotation, completed: rotation.completed + 1 },
          "Turn completed. Counter advanced to the next person."
        );
      } else {
        await this._saveRotation(
          item,
          {
            ...rotation,
            index: (rotation.index + 1) % rotation.people.length,
            completed: rotation.completed + 1,
          },
          "Turn completed. Assignments rotated locally."
        );
      }
    } catch (error) {
      await this._load();
      this._notice = `Completion error: ${String(error)}. Check the Counter state before trying again.`;
    } finally {
      this._busy = false;
    }
  }

  private _toggleCreate(): void {
    this._createOpen = !this._createOpen;
  }

  private _refreshTasks(): void {
    void this._load();
  }

  private _onNameInput(event: Event): void {
    this._name = (event.target as HTMLInputElement).value;
  }

  private _onPeopleInput(event: Event): void {
    this._people = (event.target as HTMLInputElement).value;
  }

  private _onDueInput(event: Event): void {
    this._due = (event.target as HTMLInputElement).value;
  }

  private _onRotationModeChange(event: Event): void {
    this._rotationMode = (event.target as HTMLSelectElement)
      .value as RotationMode;
    if (this._rotationMode === "manual") {
      this._timerEntity = "";
      this._scheduleEntity = "";
    } else if (this._rotationMode === "timer") {
      this._scheduleEntity = "";
    }
  }

  private _onTimerChange(event: Event): void {
    this._timerEntity = (event.target as HTMLSelectElement).value;
  }

  private _onScheduleChange(event: Event): void {
    this._scheduleEntity = (event.target as HTMLSelectElement).value;
  }

  private _onEditPeopleInput(event: Event): void {
    this._editPeople = (event.target as HTMLInputElement).value;
  }

  private _getTaskFromEvent(event: Event): TodoItem | undefined {
    const taskId = (event.currentTarget as HTMLElement).dataset.taskId;
    return this._items.find((item) => this._itemId(item) === taskId);
  }

  private _onCompleteClick(event: Event): void {
    const item = this._getTaskFromEvent(event);
    if (!item) return;
    const rotation = parseDescription(item.description).rotation;
    if (!rotation) return;
    void this._complete(item, rotation);
  }

  private _onStartEdit(event: Event): void {
    const item = this._getTaskFromEvent(event);
    if (!item) return;
    this._editId = this._itemId(item);
    this._editPeople =
      parseDescription(item.description).rotation?.people.join(", ") ?? "";
  }

  private _onCancelEdit(): void {
    this._editId = null;
  }

  private _onSaveParticipants(event: Event): void {
    event.preventDefault();
    const item = this._getTaskFromEvent(event);
    if (item) void this._assign(item);
  }

  protected render() {
    return html`
      <main>
        <header>
          <h1>Task Rotation</h1>
          <div class="actions">
            <button @click=${this._toggleCreate}>
              ${this._createOpen ? "Close form" : "Create Task"}
            </button>
            <button
              class="secondary"
              ?disabled=${this._loading}
              @click=${this._refreshTasks}
            >
              Refresh Tasks
            </button>
          </div>
        </header>
        <p class="note">
          Each new task gets its own Enhanced Counter. Choose whether rotation
          is manual or automatically triggered by a Timer.
        </p>
        ${
          this._createOpen
            ? html`<form class="card" @submit=${this._create}>
                <h2>Create household task</h2>
                <label
                  >Task name
                  <input
                    required
                    .value=${this._name}
                    @input=${this._onNameInput}
                  />
                </label>
                <label
                  >Participants (comma-separated)
                  <input
                    required
                    .value=${this._people}
                    placeholder="Person A, Person B, Person C"
                    @input=${this._onPeopleInput}
                  />
                </label>
                <label
                  >Due date (optional)
                  <input
                    type="date"
                    .value=${this._due}
                    @input=${this._onDueInput}
                  />
                </label>
                <label
                  >Rotation mode
                  <select
                    .value=${this._rotationMode}
                    @change=${this._onRotationModeChange}
                  >
                    <option value="manual">Manual only (default)</option>
                    <option value="timer">Timer-based</option>
                    <option value="timer_schedule">Timer + Schedule</option>
                  </select>
                </label>
                ${
                  this._rotationMode !== "manual"
                    ? html`<label
                        >Timer helper (required)
                        <select
                          required
                          .value=${this._timerEntity}
                          @change=${this._onTimerChange}
                        >
                          <option value="">Select a Timer</option>
                          ${this._helperEntities("timer").map((id) => html`<option value=${id}>${id}</option>`)}
                        </select>
                      </label>`
                    : nothing
                }
                ${
                  this._rotationMode === "timer_schedule"
                    ? html`<label
                        >Schedule helper (required)
                        <select
                          required
                          .value=${this._scheduleEntity}
                          @change=${this._onScheduleChange}
                        >
                          <option value="">Select a Schedule</option>
                          ${this._helperEntities("schedule").map((id) => html`<option value=${id}>${id}</option>`)}
                        </select>
                      </label>`
                    : nothing
                }
                <p class="note">
                  ${
                    this._rotationMode === "manual"
                      ? "Assignments change only when a turn is manually completed."
                      : this._rotationMode === "timer"
                        ? "Assignments change when the selected Timer finishes. Start the Timer manually or with an automation."
                        : "Assignments change when the Timer finishes, only while the Schedule is ON."
                  }
                </p>
                <button type="submit" ?disabled=${this._busy}>Save Task</button>
              </form>`
            : nothing
        }
        ${this._notice ? html`<p role="status" class="notice">${this._notice}</p>` : nothing}
        <p class="note">
          ${this._loading ? "Loading..." : `${this._items.length} active task(s)`}
        </p>
        ${this._items.map((item) => {
          const parsed = parseDescription(item.description);
          const rotation = parsed.rotation;
          const current = rotation ? this._assignedIndex(rotation) : -1;
          const linked = Boolean(rotation?.counter_entity);
          return html`<article class="card">
            <h2>${item.summary}</h2>
            <p class="note">${item.due ? `Due: ${item.due}` : "No due date"}</p>
            ${
              parsed.invalid
                ? html`<p class="error">
                    Invalid rotation data in To-do description.
                  </p>`
                : rotation
                  ? html`
                      <p>
                        Current assignee:
                        <strong
                          >${current >= 0 ? rotation.people[current] : "Counter unavailable or incompatible"}</strong
                        >
                      </p>
                      <p class="note">
                        Rotation order: ${rotation.people.join(" → ")}
                      </p>
                      <p class="note">
                        Completed turns: ${this._completedTurns(rotation)}
                      </p>
                      <p class="note">
                        ${linked ? `Counter: ${rotation.counter_entity}` : "Legacy task (edit participants to create a Counter)"}
                      </p>
                      <div class="actions">
                        <button
                          ?disabled=${this._busy || current < 0}
                          data-task-id=${this._itemId(item)}
                          @click=${this._onCompleteClick}
                        >
                          Mark turn completed &amp; rotate
                        </button>
                      </div>
                    `
                  : html`<p class="note">No participants assigned yet.</p>`
            }
            ${
              !parsed.invalid
                ? html`<div class="edit">
                    ${
                      this._editId === this._itemId(item)
                        ? html`<form
                            data-task-id=${this._itemId(item)}
                            @submit=${this._onSaveParticipants}
                          >
                            <label
                              >Participants
                              <input
                                required
                                .value=${this._editPeople}
                                @input=${this._onEditPeopleInput}
                              />
                            </label>
                            <div class="actions">
                              <button type="submit" ?disabled=${this._busy}>
                                Save participants
                              </button>
                              <button
                                type="button"
                                class="secondary"
                                @click=${this._onCancelEdit}
                              >
                                Cancel
                              </button>
                            </div>
                          </form>`
                        : html`<button
                            class="secondary"
                            ?disabled=${this._busy}
                            data-task-id=${this._itemId(item)}
                            @click=${this._onStartEdit}
                          >
                            ${rotation ? "Edit participants" : "Assign participants"}
                          </button>`
                    }
                  </div>`
                : nothing
            }
          </article>`;
        })}
      </main>
    `;
  }

  static styles = css`
    :host {
      display: block;
      color: var(--primary-text-color);
    }
    main {
      max-width: 900px;
      margin: auto;
      padding: 24px;
    }
    header,
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    header {
      justify-content: space-between;
    }
    .card {
      margin: 16px 0;
      padding: 20px;
      border: 1px solid var(--divider-color);
      border-radius: 12px;
      background: var(--card-background-color);
    }
    h1 {
      font-size: 24px;
    }
    h2 {
      font-size: 18px;
      margin-top: 0;
    }
    p {
      margin: 10px 0;
    }
    .note {
      color: var(--secondary-text-color);
    }
    .error,
    .notice {
      padding: 10px;
      border-radius: 8px;
      background: var(--secondary-background-color);
    }
    .error {
      color: var(--error-color);
    }
    button {
      font: inherit;
      border: 0;
      border-radius: 8px;
      background: var(--primary-color);
      color: white;
      padding: 10px 14px;
      cursor: pointer;
    }
    button.secondary {
      color: var(--primary-text-color);
      background: var(--secondary-background-color);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    label {
      display: block;
      margin: 12px 0;
    }
    input,
    select {
      display: block;
      width: 100%;
      box-sizing: border-box;
      margin-top: 6px;
      padding: 11px;
      border: 1px solid var(--divider-color);
      border-radius: 8px;
      background: var(--secondary-background-color);
      color: var(--primary-text-color);
      font: inherit;
    }
    .edit {
      margin-top: 14px;
    }
    @media (max-width: 600px) {
      main {
        padding: 14px;
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-panel-task-rotation": HaPanelTaskRotation;
  }
}
