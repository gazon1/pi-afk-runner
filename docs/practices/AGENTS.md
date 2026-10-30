# Singularity Todo — Agent Cheatsheet

> Загружается автоматически в каждый чат с агентом. Полная документация: `ARCHITECTURE.md`.

## Начало задачи

**Обзор документации — один раз за сессию.** `DIGEST.md` перечисляет, что где лежит:
дерево `docs/`, свежие решения, указатели. Дальше иди по именам файлов (`grep` / `find`),
а не перечитывай индексы — имена самодостаточны: `docs/architecture/sync.md` описывает sync. Полный индекс
решений — `DIGEST-full.md`, открывай его только если слоя не хватило.

**`DIGEST.md` генерируется, а не лежит в репозитории.** Файла нет в свежом клоне: он
собирается из `docs/decisions/` и лежит в `.gitignore`. Нет файла — запусти
`./scripts/refresh-decisions-digest.sh` (или `just setup-hooks`, чтобы хуки
перегенерировали его сами при checkout/merge) и прочитай его тогда.

**`git fetch` — до того, как что-либо сделал, а не на пуше.** Расхождение, найденное
в начале, стоит один rebase пустого дерева; найденное на пуше — полную перепроверку
готовой работы, потому что чужие коммиты меняют то, на что опиралась твоя.

**`sgate checkout-state` — до того, как что-либо сделал, тоже.** Checkout на машине с
несколькими клонами — общее состояние: он может нести чужие коммиты, которых нет в
`origin/main`, и это видно только изнутри. Команда говорит, что checkout несёт, насколько
он разошёлся с `origin/main` и влезает ли `AGENTS.md` в бюджет инструкций (харнесс
обрезает файл тихо, и правила за обрезом агент не читает, не зная об этом). Разошёлся —
работай в своём worktree, а не в этом.

Замер за одну сессию (2026-10-05): два ребейза, и fetch в начале сэкономил один.

Автоматизация: `scripts/session-start-check.sh` выполняет fetch + checkout-state; `scripts/gw-progress.sh` оборачивает `./gw` с отчётом прогресса.
`main` двигается параллельными траншами — чужие изменения принимай как данность и
перепроверяй, а не откатывай. `git fetch origin && git log --oneline HEAD..origin/main`.

**Механическая защита от divergence (#268):**
- `pre-rebase` hook (`.githooks/pre-rebase`) — блокирует rebase на локальный main,
  который отстаёт от `origin/main`; предупреждает о неpushнутых коммитах.
- Проверки divergence в CI больше нет: runner checkout'ит detached-коммит без трекинговой
  ветки и без рефа `origin/main`, поэтому гейт падал на каждом прогоне настройкой раннера,
  а не расхождением. Локально ту же проверку делает `pre-rebase` — на тот ref, на который
  собираешься переносить коммиты.

## Worktree: делегату — свой, канонический checkout — владельцу

**Делегированная задача (субагент) получает свой worktree.** Канонический checkout
принадлежит сессии, которая его заняла: две сессии в одном дереве — это две правки
в одном рабочем дереве и ветка, занятая чужой работой.

```bash
git worktree add /home/max/work/singularity-todo-<slug> -b <slug>/<что>
```

- **Не переключай ветку в чужом worktree** — список чужих: `git worktree list` (там, где `main`,
  ветка занята). Свою ветку — только в своём worktree.
- `./gw` даёт worktree приватный `GRADLE_USER_HOME`: `./gradlew --stop` в одном worktree убивает
  демоны всех остальных, а общий `~/.gradle` — общая блокировка кэша модулей.
- **Два Gradle-вызова одновременно не запускай** — ни два своих, ни свой и чужой: блокируется
  общий кэш, и падает не та сборка, которую ждут.
- Свой временный worktree сноси через `git worktree remove --force <path>`; чужой — не трогай.

**Правила ревью — в `CODING_STANDARDS.md`.** Файл читается на ревью, не при
реализации: там то, что ни один гейт проверить не может (согласованность между
файлами, «соответствует окружающему стилю», «сообщение говорит, что произошло»),
и таблица проверяемых конвенций с гейтом под каждой. Ревьюишь — читай его
первым; правило, у которого нет гейта, держит ревью на себе.

## Структура

`androidApp/` — Android shell. `desktopApp/` — Desktop Compose entry.
`shared/src/commonMain/kotlin/com/singularity/todo/` — KMP library (commonMain + androidMain +
jvmMain + tests): `core/` (auth, backup, coroutines, database, di, draft, error, files, ids, llm,
log, notifications, observability, platform, reminders, security, serialization, settings, sync,
tree, ui), `feature/` (agenda, ai, archive, attachments, auth, backup, calendar, checklist, genui,
notes, pomodoro, profile, projects, reminders, search, settings, statistics, tags, tasks),
`test/fakes/` (Fake-реализации, без моков). **iOS нет** — только Android + JVM.

Экспорты схемы Room — каталог `shared/schemas/com.singularity.todo.core.database.AppDatabase/` (файл на версию).

## Навигация по частым точкам

- AI tool inputs: `feature/ai/tools/*Tool.kt`, nested `*Input` data classes. Allow-list: `core/llm/ToolCallSummary.kt` (`IDENTIFYING_FIELDS` / `FREE_TEXT_FIELDS`).
- Maestro flows: `Maestro/flows/`. Helpers: `Maestro/helpers/`. Конвенции: `Maestro/CONVENTIONS.md`.
- Supabase локально: `docs/architecture/local-stack.md`. Ключи из `.env` стека.
- Тесты arch: `shared/src/jvmTest/kotlin/com/singularity/todo/arch/`.
 В `jvmTest` их читает **один** владелец: `MigrationRoundTripSupport.applyExportedSchema(N, connection)`
(и `schemaFile(N)` — путь к экспорту). Тест миграции пишет «посади вот это — проверь вот это»,
а не SQL; свой экземпляр фикстуры — это copy-paste, который ловит `MigrationFixtureHasOneOwnerTest`.

## Канонический CRUD-паттерн (новой фичи)

`Ids.kt` (@JvmInline value class) → `*Domain.kt` (валидация) → `*Repository.kt`
(интерфейс: `Result<T>`, suspend, Flow) → `*RepositoryImpl.kt` (Room) → `*UseCase.kt`
(**только реальная логика**, не pass-through — enforced by `PassThroughUseCase` detekt rule)
→ `*ViewModel.kt` (`StateFlow<SealedUiState>`, sealed Intent, инъектированный scope)
→ `*Screen.kt` (Compose).

## DI: Koin 4.x (pure DSL)

**DI-валидация:** `koin-compiler-plugin 1.2.1` (build-logic/Plugins.kt) даёт
compile-time проверку графа; аннотации (`@Single`, `@Factory`) не используются.
**Никогда** не используй `*domainModule().toTypedArray()` в `modules()` — это даёт
KOIN-W003 (graph unverifiable). Используй list composition:
`modules(listOf(...) + domainModule() + listOf(...))`.

| DSL | Когда |
|---|---|
| `single { Repo(get()) }` | singleton |
| `viewModelOf(::Vm)` | все VM без runtime-параметров (**prefer**) |
| `viewModel { (p: Param) -> Vm(get(), p) }` | VM с runtime-параметрами |
| `koinViewModel()` / `koinViewModel { parametersOf(p) }` | инъекция VM в Composable (не `koinInject()`) |
| `factory { Vm(...) }` | **Never** для VM — memory leak |
| `koinInject()` | репозитории и сервисы (не VM) |

**Где лежат биндинги.** `core/di/Modules.kt` — **фасад-агрегатор** (`coreLoggingModule()` +
`domainModule(): List<Module>`), не источник истины. Реальные биндинги — в per-domain
`core/di/{Core,Calendar,Notes,Projects,Tags,Tasks}DiModule.kt` и `feature/*/*DiModule.kt`
(каждая отдаёт свою `*Module()`), платформенные — в `core/di/PlatformModule.{jvm,android}.kt`.

> Список, а не `includes()`: `includes()` создаёт child scope, и биндинги из него не видны соседним
> модулям на parent level (ADR `2026-09-27-di-module-aggregator-narrative.md`; скилл `singularity-todo-koin-di`).

## Тесты

**Правила и рецепты тестов — `docs/architecture/tests.md`:** где живут тесты
(`commonTest` выполняется внутри `:shared:jvmTest`), fake вместо моков, теги
`fast`/`slow` и под-теги, харнесс ViewModel-тестов, диагностика падений
(`build/diagnostics/<TestClass>/coroutines.txt`), BAN list, каталог тегов
`Maestro/TAGS.md`, сканер тестов `scripts/scanning.py`. Иди туда, когда пишешь
тест или разбираешь падение.

Миграционные тесты помечены `@Tag("slow")`; запуск: `./gw :shared:jvmTest -Ptest.tags=slow`.
## expect/actual порты

Порт — интерфейс в `commonMain`, два actual, `single<Port>` в обоих
`PlatformModule.*.kt`. Единственный expect/actual seam — `platformModule()`.
Инвентарь портов, фабричные функции, время и NavGraphs — `docs/PLATFORM-REFERENCE.md`.

## Сборка и гейты

**Порядок проверки — `docs/architecture/verification.md`:** `./gw` вместо
`./gradlew` (приватный `GRADLE_USER_HOME` на worktree), карта команд
(`just gate`, `./check.sh`, `bash scripts/ci/static-gates.sh`), порядок detekt,
компиляция сразу после связной правки, долгий запуск как одна фоновая задача,
загрузка хоста (`./sg host-load`), вердикт CI, причина упавшего теста в артефакте,
вердикт ревью. Иди туда перед запуском гейтов.

**Живой стек — `docs/architecture/local-stack.md`:** рецепт подъёма Supabase
локально, применения миграций этого репозитория (`supabase/migrations/`) и
проверки их результата. Нужен там, где правка живёт на сервере: политики RLS
бакета `backups` и таблица `google_calendar_grants`.


**Реестр гейтов — единственный список.** `scripts/ci/static-gates.sh` и
`docs/scripts/gate-registry.md` генерируются из него, руками их не правь. Новый
гейт = одна запись в реестре + строка
`gate blocking|advisory <name> <cmd>`; `|| true` на строке `gate` запрещён.
Branch protection требует **один** check — `CI gate`. Как зарегистрировать гейт —
`docs/architecture/registering-a-gate.md`.
## CI/CD

**CI/CD — `docs/architecture/ci.md`:** реестр гейтов и его проекции, поверхности
CI, ожидание прогона (`gh pr checks <pr> --watch --interval 60`), правило «один
запуск — один файл», свойства прогона. Иди туда, когда ждёшь CI.

## 🤖 Dogfooding, spec-kit, Run-loop

- **MCP-сервер** (задачи/проекты/заметки/теги/ADR из агента) — скилл
  `singularity-todo-mcp-dogfooding`; полный список tools — `docs/architecture/mcp-server.md`.
- **spec-kit / OpenSpec** (решение «change или ADR», артефакты, верификация) —
  скилл `singularity-todo-openspec-workflow`; полный справочник — `docs/spec-kit-guide.md`.
  Реестр ченджей — `.specify/issues/<slug>.yaml`, запись создаётся **сразу** после
  создания ченджа.
- **UI-верификация** — скиллы `singularity-todo-emulator-launch` (запуск и
  восстановление AVD), `singularity-todo-desktop-compose-ui-tests` (харнесс и
  компонентные тесты), `singularity-todo-android-cli` (CLI и разбор БД).

## 🤖 Coroutine test failures

Любой JVM-тест при падении пишет `build/diagnostics/<TestClass>/coroutines.txt` (состояние,
контекст, job-иерархия, стектрейлы) — читай **первым**: кадры приложения раньше kotlinx указывают,
где корутина была, умерла она там, где `lastObservedStackTrace`, а одинаковые стектрейсы — не
доказательство утечки. ADR `2026-10-03-kotlinx-coroutines-debug.md`, разбор — шаг 5 `debugging-investigation`.

## ❌ Что НЕ делать

1. **`runBlocking` в ViewModel init** — вместо этого `combine(...)` + `flatMapLatest`
2. **`*Blocking()` методы в репозиториях** — только suspend + Result<T>
3. **MockK / Mockito** — fakes для state-тестов; MockK только для исходящих вызовов
4. **Pass-through CRUD use cases** — VMs инжектят репозиторий напрямую (AI — допустимо);
   enforced by `PassThroughUseCase` detekt rule
5. **`java.io.File` в `commonMain`** — только через `FileSystem` порт (`core/files/`).
   В `jvmMain`/`androidMain` это и есть реализация порта, там `java.io.File` — правильный
   инструмент; то же в тестах, которые читают дерево исходников. Правило держит
   feature-код, а не платформенный слой: в репозитории `java.io.File` встречается
   в 110 файлах, и запрет без границы учит только игнорировать запрет.
6. **`require { throw ... }` внутри лямбды** — `require` сам бросает
7. **Импортировать Koog-типы вне `feature/ai` и `core/di`**; **грубые изменения Room
   schema** без `SCHEMA_VERSION` + `AutoMigration`
8. **Пайпить вывод команды в `tail`/`head`** — `cmd | tail -3` убивает `cmd` сигналом SIGPIPE:
   код выхода пайпа — это код выхода `tail`, а не команды, и `git push` уходит с 141, не
   отправив ничего. Перенаправляй в файл (`cmd > /tmp/probe/push.log 2>&1`) и читай файл.
   Замер: 6 пушей в одной сессии ушли с 141 и «успешным» кодом выхода.
9. **Пушить по SSH без keepalive, когда pre-push длинный** — git открывает соединение с
   GitHub *до* хука, и пока хук крутит detekt (несколько минут), соединение простаивает:
   GitHub закрывает его, и пуш падает с 141, хотя хук только что напечатал
   `=== Pre-push OK ===`. Это тот же 141, но другая причина. Лечится keepalive:
   `git config core.sshCommand "ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=10"`.

## 🗂 Коммиты

Один коммит — одна мысль; в этом репозитории так принято, и diff на 100 файлов
читается плохо. Когда работа распадается на части (фичи, пункты списка,
«это и это вместе»), разложи её **до** коммита, а не после:

1. `git add -p` по логическим кускам — или `git add <путь>` по файлам целиком,
   если куски совпадают с файлами;
2. один `git commit` на кусок, с сообщением в стиле репозитория:
   `feat(area): что изменилось` + абзац «почему» + ссылки на ADR и OpenSpec;
3. каждый коммит должен собираться и проходить гейты сам по себе — иначе
   bisect указывает на место, которого не существует.

Регенерируемые файлы (`scripts/ci/static-gates.sh`, `docs/scripts/gate-registry.md`,
`docs/SKILLS-CATALOG.md`) в коммит попадают вместе с тем, что их породило.

## 🧠 Decision log

Если задача меняет архитектуру, контракт или обнаруживает неочевидный workaround — создай запись в
`docs/decisions/YYYY-MM-DD-<slug>.md` и пересобери digest (`./scripts/refresh-decisions-digest.sh`).
**Писать:** выбор между несколькими разумными вариантами; неочевидный workaround; изменение
контракта между слоями. **Не писать:** опечатки, форматирование, новый use case по существующему
паттерну. Формат: frontmatter + `Context / Idea / Decision / Rationale / Consequences / Links`;
policy — `docs/doc-maintenance.md`.

## 🗂 Skills

Скилл — это **процедура**: что агент делает. Состояние кода — это документ в `docs/architecture/`
(см. обзор в `DIGEST.md`). Каталог — `docs/SKILLS-CATALOG.md` (auto-generated, не редактировать);
правила написания — `writing-for-agents`.

> **Фича «готова», но ничего не делает** — самый частый дефект: код компилируется, покрыт
> тестами и **не вызывается никем**. Проверка: `scripts/find-unwired-surfaces.py`.

Issue tracker — `docs/agents/issue-tracker.md`; доменные доки — `docs/agents/domain.md` (`CONTEXT.md`
в корне, ADR-и в `docs/decisions/`). Список снятых скиллов и причина каждого — `docs/doc-maintenance.md`.
