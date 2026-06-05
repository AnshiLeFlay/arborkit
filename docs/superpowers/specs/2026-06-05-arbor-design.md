# Arbor — дизайн (v1)

- **Дата:** 2026-06-05
- **Статус:** дизайн согласован, готов к написанию плана
- **Рабочее имя:** Arbor (плейсхолдер, переименуемо)
- **Расположение проекта:** `c:\code\tools\arbor\`

---

## 1. Контекст и мотивация

Arbor — это библиотека общего назначения для мультиагентных систем, где **центральный артефакт — это одно JSON/древовидное общее состояние**, а агенты:

1. **не грузят дерево целиком в контекст**, а навигируют его через тулы, подгружая узлы по требованию (lazy/on-demand);
2. имеют **два канала доступа к узлам**: точный (по идентичности — id/path/tag) и семантический (по смыслу — эмбеддинги/вектор → top-k);
3. **конкурентно (партиционированно) редактируют** один артефакт с версионированием.

### Вывод исследования (зачем это вообще строить)

Два прохода deep-research показали: **готового general-purpose фреймворка, объединяющего {древовидный JSON-артефакт + tool-навигация агента on-demand + семантический индекс над узлами + версионирование + render-agnostic потребление}, не существует.** Каждый слой закрыт по отдельности, но никто не держит данные как единый адресуемый, семантически-индексируемый артефакт-**дерево**:

- **Letta/MemGPT** — ближайший prior art (структурированная память + семантический индекс + lazy tool-навигация + self-edit), но модель данных — **плоские блоки/файлы, не дерево**.
- **LangGraph BaseStore** — встроенный семантический поиск по namespaced-ключам, но **плоский KV, не дерево, без ленивой подгрузки узлов**.
- **AG-UI** — sync состояния snapshot + JSON-Patch (RFC 6902), но full-state, без семантики и CRDT.
- **Vercel json-render / A2UI** — render-agnostic потребление JSON-дерева по id/JSON-Pointer, но без семантики/версий/навигации.

**Незанятая ниша = объединяющее звено:** версионируемое JSON-дерево, которое одновременно несёт per-node семантический индекс, сшитый с tool-навигацией. Это и есть differentiator Arbor.

### Несущий подход

«**Артефакт-стор + тулы**» (document-centric): Arbor — самостоятельный стор артефакта (дерево узлов + индекс + event-log + tool-surface) плюс набор тулов для агента. Оркестратор-агностичен. Подход Letta берём только как источник вдохновения для имён/семантики тулов (`grep`/`open`/`semantic_search`), не как несущую модель.

---

## 2. Цели и не-цели

### Цели (v1)
- Дерево-артефакт с **точной адресацией** (id/path/tag) — обязательно для патча.
- **Семантический векторный индекс над узлами** в v1 (это differentiator, не откладываем).
- **Tool-навигация** с ленивой подгрузкой (`describe`/`get`/`search`/`find`/`patch`/`history`).
- **Версионирование** через append-only event-log + снапшоты, **CRDT-ready** (ops id-якорные), но без CRDT.
- **Scoping записи** по поддереву (каждый агент правит свою часть структурно).
- Язык-агностичное **чистое ядро** с дисциплиной «проектируй как удалённое» (сериализуемые вход/выход, async, адресация по id/path).

### Не-цели (явно вне скоупа v1, но швы заложены)
- MCP-серверный адаптер (фаза 2 — есть реальный второй не-Node потребитель).
- DB-адаптеры (SQLite+sqlite-vec / Postgres+pgvector).
- CRDT-бэкенд (конкурентная запись в один узел).
- Интеграция в реальный content-generator (отдельный downstream-проект со своей спекой).
- Render-agnostic слой потребления (отдельная забота).

---

## 3. Скоуп v1

**В скоупе:** ядро (домен) + порты + in-memory/file-snapshot адаптеры + in-process тулсет + mock `EmbeddingPort` + in-memory `VectorIndexPort` + примеры + тесты.

**Рантайм:** TypeScript/Node (тот же, что у первого будущего носителя content-generator).

**content-generator — референс, не зависимость:** его формы данных (`SiteStructure`/`PageContent`/`BrandFacts`/`DesignSystem`) используются как scenario-фикстуры тестов, доказывающие достаточность API. Сам content-generator строится поверх Arbor позже, отдельной спекой.

---

## 4. Архитектура

Чистая ports-and-adapters (гексагональная). Три кольца: интерфейс-адаптеры → чистое ядро → порты/адаптеры.

```
                 ┌─────────────────────────────────────────────┐
   агенты  ──►   │  Interface adapters                          │
 (LangChain-     │   • InProcessToolset (функции + LangChain    │
  тулы; позже    │     tools)                                   │
  MCP-клиенты)   │   • McpServer (resources + tools)  [фаза 2]  │
                 └───────────────────┬─────────────────────────┘
                                     │  сериализуемо, async
                                     ▼
                 ┌─────────────────────────────────────────────┐
                 │  CORE  (чистый, транспорт-агностичный)       │
                 │   Navigator  describe / get / search / find  │
                 │   Mutator    patch-ops + scope + event-log   │
                 │   ArtifactTree · Node · Addressing           │
                 │   Index   exact: id/path/tag · semantic: vec │
                 └───────┬──────────────┬───────────────┬───────┘
                         ▼              ▼               ▼
                  StoragePort    EmbeddingPort   VectorIndexPort
                  in-memory      LLM-провайдер   in-memory (v1)
                  file-snapshot  (swappable)     pgvector/sqlite
                  sqlite/pg(later)               (later)
```

### Компоненты ядра (без I/O)
- **`ArtifactTree`** — агрегат одного артефакта; держит узлы в памяти.
- **`Node`** — единица дерева (см. §5).
- **`Addressing`** — резолв по `id` и JSON Pointer `path`; индексы `id→node`, `path→node`; поддержание консистентности `path↔id` на каждой мутации.
- **`Navigator`** — read-side: `describe`/`get`/`search`/`find` с лимитами/пагинацией.
- **`Mutator`** — применяет ops; пишет в event-log; обновляет индексы; помечает эмбеддинг устаревшим; проверяет write-scope; валидирует типом.
- **`Index`** — два канала: exact (`id`/`path`/`tag`/`type`) + semantic (вектор).

### Порты
- **`StoragePort`** — load/persist узлов + лог (in-memory, file-snapshot; later sqlite/pg).
- **`EmbeddingPort`** — текст → вектор (провайдер сменный; в тестах — mock).
- **`VectorIndexPort`** — upsert/search/remove векторов (in-memory brute-force в v1; later pgvector/sqlite-vec).
- **`Clock` / `IdGen`** — инъектируемые для детерминизма в тестах.

### Несущее правило
Граница «агент↔ядро» говорит только в сериализуемых терминах (`id`, `path`, JSON-значения, строка-запрос) и async → in-process и MCP адаптеры одинаковой формы. Это дисциплина «ядро как удалённое».

---

## 5. Модель данных и адресация

### Узел
```
Node {
  id:       NodeId             // стабильный, непрозрачный, выдаётся при создании — НИКОГДА не меняется
  parentId: NodeId | null      // null = корень
  key:      string | number    // ключ этого узла у родителя (имя поля или индекс массива)
  path:     string             // JSON Pointer (RFC 6901) — ПРОИЗВОДНЫЙ от структуры, кэш
  kind:     "object" | "array" | "leaf"
  content:  Json | null        // leaf: значение/непрозрачное поддерево; object/array: null
  tags?:    string[]           // метки идентичности для exact-доступа, напр. "brand-fact:price"
  type?:    string             // имя типа из реестра (schema-optional)
  meta: {
    version, updatedAt, owner?,
    embedding: { state: "fresh"|"stale"|"none", textHash?, vecRef? }
  }
}
```

### Гранулярность
Не дробим до каждого скаляра. Дерево — **структурный скелет** (`object`/`array`-контейнеры); **content-bearing узлы** (`leaf` или непрозрачное поддерево) несут нагрузку и только они — кандидаты на эмбеддинг (как у LlamaIndex эмбеддятся только листья).

**Граница декомпозиции — размер по умолчанию + оверрайд по типу (A+B):**
- дефолт (любой JSON, без настройки): дробим `object`/`array`, пока сериализованный размер поддерева > порога; меньше — кладём целиком как непрозрачный `leaf`;
- зарегистрированный тип может переопределить через `decompose: "opaque" | "children"` — **тип бьёт размер**.

Так работает из коробки на произвольном JSON (размер) и точно там, где есть схемы (тип). Размер = сериализованные байты; порог конфигурируем.

### Идентичность vs путь
`id` — это «кто» (стабилен, переживает перемещения). `path` — это «где сейчас» (производный, меняется при insert/remove соседей). **Индекс всегда ключуется на `id`.** Внутри резолвим `path → id → node`; после `move` путь обновляется, id остаётся. Сохранённая агентом ссылка на `id` не протухает.

### Addressing API
`byId(id)` · `byPath(pointer)` · `byTag(tag) → Node[]`.

### Schema-optional
- Ядро работает с **произвольным JSON**, схема не обязательна.
- Опционально — **реестр типов**: именованный тип + валидатор. Поскольку референс-носитель на **Zod** — адаптер оборачивает Zod-схему как валидатор. Узел несёт `type`.
- Если тип привязан — `Mutator` **валидирует патч** против него (артефакт остаётся валидным). Нет типа — пишется что угодно.
- Тип улучшает аффордансы `describe` и делает извлечение текста для эмбеддинга **type-aware**.

### Извлечение текста для эмбеддинга
На узел — функция `toEmbeddingText(node) → string | null`. Дефолт: стрингифай content-leaf. Type-aware оверрайд указывает, какие поля эмбеддить (аналог per-field `index=['title','body']` в LangGraph BaseStore). `null` → узел не эмбеддится.

---

## 6. Tool-surface

```
// ── READ / NAVIGATE (по умолчанию в пределах readScope агента) ──
describe(ref?=root, {depth=1, offset, limit}?)        // дёшево, аналог `ls`
   → { node:{id,path,key,kind,type},
       children:[{id,key,kind,type,hasChildren,size,preview}],   // БЕЗ полного контента
       truncated?:{shown, total, nextOffset} }

get(ref, {maxDepth, maxBytes}?)                       // дорого, аналог `cat`
   → { id, path, type, content, meta, truncated? }

search(query, {k=8, under?, type?, tag?, freshness?}?) // СЕМАНТИКА (вектор) — «по смыслу»
   → { results:[{id,path,type,score,snippet}], staleCount }

find({tag?|type?|pathPattern?}, {limit}?)             // EXACT (детерминированно) — «по id»
   → [{ id, path, type }]
   // pathPattern = glob по JSON Pointer: `*` = один сегмент, `**` = любая глубина (напр. /pages/*/title)

// ── WRITE (проверяется против writeScope; валидируется типом; пишется в лог) ──
patch(ref, {op:"set"|"insert"|"remove"|"move", key?, value?, to?, ifVersion?})
   → { id, path, version, node }                      // подтверждение, чейнится
   // словарь op зеркалит JSON Patch (RFC 6902), адресация по id ИЛИ path

// ── VERSIONING (read-side) ──
history(ref?, {limit}?)
   → [{ seq, op, nodeId, actor, ts }]
```

### Принципы
- **Дешёвый `describe` ≠ дорогой `get`.** Навигация листает структуру; контент тянем точечно.
- **Два канала finder'а разными тулами** (это разные структуры): `search` = вектор/смысл, `find` = точный селектор. Прыжок вместо пошагового обхода убивает проблему глубины.
- **Все результаты self-describing и bounded:** несут `id`+`path`; перечисляют детей (куда идти дальше); лимитируют размер. **Никакого тихого обрезания** — `truncated` явно говорит `shown/total/nextOffset`.

### Scoping живёт в конструкторе тулсета
```
makeToolset({ tree, owner, writeScope?, readScope? })
   → { describe, get, search, find, patch, history }
```
`writeScope` (поддерево) — `patch` за его пределы отклоняется; `null` → read-only агент. `readScope=null` → читает всё. Агенту дают **уже суженный** тулсет; сами тулы простые.

### In-process / MCP
In-process — async-функции + обёртки в LangChain `tool()`. Фаза 2 — те же 6 как MCP-тулы + дерево как MCP **resources** (шаблон `artifact://{artifactId}/node/{id}`).

---

## 7. Семантический индекс и инвалидация

### Два канала
- **Exact — синхронный, бесплатный.** Map'ы `id→node`, `tag→[node]`, `type→[node]`, обновляются в транзакции мутации. Сложности нет.
- **Semantic — асинхронный, с ценой.** Эмбеддинг — вызов модели; нельзя класть в синхронный путь `patch`. Разделяем **мутацию** и **переиндексацию**.

### Что эмбеддится
Только content-bearing узлы с `toEmbeddingText(node) ≠ null` (type-aware). Структурные контейнеры — нет.

### Жизненный цикл инвалидации (ко-локированное `meta.embedding`)
```
patch(node):
   применить op, version++, append в event-log
   text    = toEmbeddingText(node)
   newHash = hash(text)
   if text == null:                          state="none";  vectorIndex.remove(id)
   elif newHash != meta.embedding.textHash:   state="stale"; enqueue(id)
   else:                                      // встроенный текст не изменился — ничего
```
Следствия, гасящие риски:
- **Патч в неиндексируемое поле — бесплатен** (хешируем именно embedding-text).
- **`move` не инвалидирует** (меняет path, не контент; эмбеддинг ключуется на id и считается из контента).
- **Инвалидация локальна и транзакционна** — нет отдельного стора, который надо догонять.

### Переиндексатор (async, батчем)
```
pull stale → batch → EmbeddingPort.embed(texts) → VectorIndexPort.upsert → state="fresh", store textHash
```

### Свежесть `search` (три режима)
- `best-effort` (дефолт): ищет по свежему, возвращает `staleCount` (без тихого вранья).
- `wait`: флашит очередь ре-индекса в пределах `under`-scope перед поиском → корректность когда важно.
- явный `reindex(scope?)` — форс-флаш (границы стадий).

### Хранилище векторов
`VectorIndexPort`: в v1 in-memory brute-force косинус (ок до ~10k узлов). Хранит `{nodeId, vector, model, dims}`. Позже pgvector/sqlite-vec через тот же порт.

### Производность
Индекс — производные данные, пересоздаваем из артефакта. В file-снапшот вектора кладём вместе с деревом; если их нет — лениво пересчитываем.

### Контроль цены
Эмбеддим только content-узлы; пропускаем при неизменном хеше; батчим; `EmbeddingPort` сменный (можно дешёвую/локальную модель).

---

## 8. Мутации, версии, scoping, ошибки

### Мутация = одна `patch` = одна транзакция
```
1. resolve ref → node                              (иначе NodeNotFound)
2. scope-check: target ⊆ writeScope                (иначе ScopeViolation)
3. type-validate РЕЗУЛЬТАТ против типа             (иначе ValidationError) — ДО применения
4. apply: правим in-memory; новым узлам id; обновляем Addressing(path↔id) + exact-индексы
5. version++, updatedAt, owner
6. append в event-log {seq, op, nodeId, payload, actor, ts}
7. stale-маркировка эмбеддинга (§7)
```
Всё-или-ничего: валидируем полностью, потом применяем.

### Атомарность при async-интерливе
JS однопоточный; одна `patch` отрабатывает целиком без вытеснения (внутри критической секции нет `await` — эмбеддинг отложен). Параллельные writer'ы интерливятся только на границах `await`, пишут в разные поддеревья → контента за один узел нет. Для много-оп консистентного изменения — `transaction(fn)` (группа ops атомарно, один батч событий).

### Версионирование (с реплеем до версии — в v1)
- **event-log** — append-only, монотонный `seq`; источник правды истории. **События обратимы** (хранят `before`+`after` на узел) → реплей/undo без миграции.
- **`meta.version`** на узле — дешёвая проверка «изменилось ли».
- **снапшоты** — сериализация дерева (+вектора) в `StoragePort`; служат **checkpoint'ами** для быстрого реплея.
- **`history(ref)`** читает события (что/кто/когда).
- **Реплей до версии (в v1):**
  - `getAt(ref, version)` — состояние узла на заданной версии/seq;
  - реконструкция полного дерева на seq N = ближайший снапшот ≤ N + реплей событий вперёд;
  - `revert(ref, toVersion)` — откат узла/поддерева к прошлой версии (узловой откат «QA правит одну страницу»);
  - `diff(vA, vB)` — разница между версиями.

### CRDT-readiness (не строим сейчас)
Ops адресованы по стабильному `id` (не индексу массива), записаны как семантические операции с `actor`+`ts` — форма для operation-based CRDT. Подстановка позже: шаги 4+6 заменяются на CRDT-док (Yjs/Loro/Automerge); `insert/move` уже id-якорные; API не меняется.

### Scoping
Структурная гарантия «каждый правит свою часть»: тулсет привязан к `{owner, writeScope, readScope}`; `patch` вне `writeScope` отклоняется; мутации штампуют `meta.owner`.

### Ошибки — типизированные, как структурированный результат
Агент видит `{ok:false, error:{code, message, …}}` и чинит/повторяет:
- `NodeNotFound(ref)`
- `ScopeViolation(ref, writeScope)` — называет разрешённый scope
- `ValidationError(type, details)` — возвращает ошибку валидатора (зеркалит Zod-retry)
- `StaleVersion(ref, expected, actual)` — **опциональный** оптимистичный замок (`ifVersion`); шов, куда позже встанет политика реальной конкуренции (reject/merge/CRDT) без переделки API.

Все ошибки сериализуемы → одинаково ходят через in-process и MCP.

---

## 9. Валидация и тестирование

Доказываем без хоста: **mock-порты + детерминированные фикстуры, без живого LLM и сети.**

### 1. Unit (компонент изолированно)
- `Addressing` — резолв id/path; консистентность `path↔id` после insert/remove/**move**.
- `Mutator` — каждая op; отклонение по валидации/scope; version++; append; «валидируем-потом-применяем».
- Exact-индекс — tag/type-map'ы на мутации.
- Semantic-индекс — stale-логика; **textHash-дедуп**; **move = нет инвалидации**.
- `Navigator` — `describe` shallow + `truncated/offset`; `get` лимиты; self-describing поля.
- EventLog/snapshot — монотонный seq; снапшот+реплей = то же состояние.

### 2. Integration (ядро + in-memory адаптеры)
- **mock `EmbeddingPort` = детерминированные вектора** (хеш-based) → предсказуемый top-k, ноль флаки.
- Цикл переиндексатора: mutate → stale → reindex → fresh; режимы свежести.
- Scoped-тулсет end-to-end: `writeScope` отклоняет чужое, `readScope` ограничивает видимость.
- file-snapshot адаптер: persist → reload → идентичные дерево+вектора.

### 3. Scenario / e2e (фикстуры формы content-generator)
- Маленький сайт: `root → pages[3]` (`PageContent`), `designSystem`, `brandFacts` (тегированные).
- Мульти-агентный флоу: тулсет «content-writer» `writeScope=/pages/0` читает brand-facts через `find(tag)`, дизайн через `get`, патчит свою страницу; **ассертим, что НЕ может патчить `/pages/1`** (`ScopeViolation`); тулсет «qa» ищет семантически и патчит точечно.
- Ассертим bounded-пейлоады (`describe`/`get` не отдают всё дерево).

### 4. Example (`examples/`)
Маленький запускаемый скрипт — сценарий как живая документация + проверка эргономики; семя для будущего content-generator.

### Дисциплина
Инъектируемые `Clock`/`IdGen` → детерминированные id/время; mock-эмбеддинги детерминированы; сети в тестах нет. Компоненты пишем **test-first** (TDD на этапе плана).

---

## 10. Предлагаемый порядок сборки (для плана)

1. **Доменное ядро без индекса:** `Node`, `ArtifactTree`, `Addressing` (id/path, консистентность при move), unit-тесты.
2. **Мутации + версии:** `Mutator` (ops, валидация, scope), **обратимый event-log (before/after)**, типизированные ошибки, `transaction`.
3. **Schema-optional:** реестр типов + Zod-адаптер; валидация на патче; **decompose-оверрайд по типу**.
4. **Navigator:** `describe`/`get`/`find` (`find` с glob-`pathPattern`) + bounding/pagination/self-describing.
5. **Semantic-индекс:** `EmbeddingPort`/`VectorIndexPort` (mock + in-memory), `toEmbeddingText`, stale-цикл, переиндексатор, `search` + режимы свежести.
6. **Storage:** in-memory + file-snapshot адаптеры (дерево + вектора), снапшоты как checkpoint'ы, restore.
7. **Реплей/время-путешествие:** `getAt(ref, version)`, реконструкция полного дерева на seq (от ближайшего снапшота), `revert(ref, toVersion)`, `diff(vA, vB)`.
8. **Тулсет:** `makeToolset` со scoping + LangChain-обёртки.
9. **Scenario/e2e + example.**

---

## 11. Будущие швы (вне v1)

- **MCP-адаптер** (фаза 2) — те же тулы + дерево как resources.
- **DB-адаптеры** — SQLite+sqlite-vec (embedded) / Postgres+pgvector (shared) через `StoragePort`/`VectorIndexPort`.
- **CRDT** — через `StaleVersion`-шов и id-якорные ops.
- **content-generator поверх Arbor** — отдельная спека.
- **Render-agnostic потребление** — отдельная забота.

---

## 12. Открытые вопросы

Решены в ходе ревью:
- ~~формат `pathPattern`~~ → **glob по JSON Pointer** (`*` сегмент, `**` любая глубина).
- ~~граница декомпозиции~~ → **размер-дефолт + оверрайд по типу (A+B)**.
- ~~реплей `history`~~ → **реплей до версии в v1** (обратимые события, `getAt`/`revert`/`diff`).

Остаётся (деталь реализации, решим в плане):
- Конкретная функция mock-эмбеддинга для тестов (хеш→вектор фиксированной размерности): размерность и функция так, чтобы косинус был осмысленно различим и детерминирован.

---

## Приложение: отображение на content-generator (референс)

| Концепт Arbor | В content-generator |
|---|---|
| дерево-артефакт | `ProjectParams → KeywordAnalysis → SiteStructure(+BrandFacts) → DesignSystem → PageContent[slug]` |
| типы узлов (Zod) | 8 существующих Zod-схем |
| exact-доступ по тегу | `BrandFacts` (канон-факты), `[ref:fact-N]` |
| семантический индекс | зачаток — `design-uniqueness` cosine по fingerprint'ам |
| scoped writer | `content-writer` (concurrency=6), `writeScope=/pages/<slug>`, `readScope=root` |
| ретро-правка | «QA правит одну страницу, а не пере-гоняет run» |
