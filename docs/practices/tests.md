# Тесты — правила и рецепты

Правила тестов — здесь, а не в `AGENTS.md`: файл, который читает каждая сессия,
должен помещаться в один проход, а правило тестов — это десятки строк, которые нужны
тогда, когда пишешь тест или разбираешь падение.

`commonTest` (pure Kotlin) выполняется внутри `./gradlew :shared:jvmTest` — отдельного таска нет.
`jvmTest` — Room + SQLite + Konsist arch tests. **Fake вместо моков** — все двойники в
`test/fakes/FakeRepositories.kt`. Каждый тестовый класс обязан иметь `@Tag`, иначе
`-Ptest.population=fast` в CI (и `-Ptest.population=full` в ночном прогоне) молча его
исключит (`TestTagCoverageTest`). **`slow` = класс
пересекает границу процесса** (Compose-харнесс, реальный файл/БД/часы, Konsist-скан, spawn),
не «долгий». Никаких skipped: `@Disabled` или упавший assumption guard валят `check-test-runs.py`.

**Под-тег `slow` — что именно медленно.** Медленный класс несёт второй тег из словаря:
`slow:konsist`, `slow:migration`, `slow:compose`, `slow:data`, `slow:platform`. Основной тег
(`fast`/`slow`) остаётся: CI выбирает по нему, и класс без него не попал бы ни в один прогон.
Словарь закрытый — гейт `TestTagCoverageTest` проверяет и основной тег, и под-тег.

```kotlin
// Три формы теста (singularity-todo-test-helpers skill):
testVm({ vm: MyVm -> vm.state }) { MyVm(deps, scope = this) }
ctx.act { it.onIntent(Intent.Load) }
ctx.assertIs<UiState.Content>()
awaitState { vm.state.value is UiState.Content }   // виртуальное время, не delay()
```

**Тест VM — через харнесс** (`testVm` из `shared/src/commonTest/.../test/helpers/RunVmTest.kt`),
и это гейт: `SharedHarnessConventionsTest`, правило «runVmTest is used for ViewModel tests» —
свой scope руками = падение. Исключения и их причины — `EXEMPT_VM_TEST` в
`shared/src/jvmTest/.../arch/SharedHarnessConventionsTest.kt` (карта «файл → причина»;
типичная повестка: поток часов не кончается → виртуальное время не доводится до idle, scope
не может быть тестовым).

**`@Tag("slow")` — тест, который локальный цикл не гоняет.** Дефолтный прогон
исключает `slow`, поэтому поломка в таком тесте видна только в CI: `McpServerEndToEndTest`
лежал сломанным в `main` несколько мержей. Полный прогон (`-Ptest.population=full`) обязан
выполнить каждый `slow`-класс — это проверяет `scripts/check-slow-tests-ran.py` (шаг CI сразу
после прогона: следующие Gradle-шаги могут перезаписать отчёт). Модули `adr-cli` и
`adr-core` тоже гоняются в CI — иначе их `slow`-классы не выполнялись бы нигде.

### Тесты гейт-сьюта

Сьют гейтов живёт в `scripts/tests/`, и точка входа у него одна:
`python3 scripts/run-gate-tests.py`. Раннер сам привязывает пакет `sgate` к
своему дереву и передаёт привязку дочерним процессам, поэтому прямой запуск
тестового модуля (`python3 scripts/tests/test_*.py`) обходит её — и измеряет
не тот checkout, который имеет в виду автор.

Правило привязки — **одно на все скрипты**: любой скрипт, который импортирует
`sgate.*`, обязан привязать пакет к своему дереву **до** импорта (`sys.path.insert`
с путём к `scripts/src`). Область правила — **весь репозиторий**, кроме
установленного пакета `scripts/src/` (его модули импортируют друг друга
абсолютными именами — они и есть пакет). Перечисление каталогов было бы
правилом, который выполняется именем каталога, а не скриптом: скрипт в
`scripts/lint/` или `infra/` импортировал бы пакет по тому, что лежит в
окружении, и никто бы об этом не сказал.

Исключение одно — пометка `# no-sgate:` в шапке, и она у тех скриптов, которые
не импортируют `sgate` вовсе: спросить, откуда взялся пакет, нельзя,
импортировав его. Проверяет правило `scripts/check-script-conventions.py`
(находка R2.5) — и привязку **после** импорта он находит так же, как её
отсутствие.

### BAN list

| Запрещено | Почему | Альтернатива |
|---|---|---|
| `stateIn` в ViewModel | держит upstream active 5s, ломает тесты без subscriber | `MutableStateFlow + scope.launch { }.collect {}` |
| `viewModelScope` в production | tight coupling, нетестируемо | инъектированный `AutoCloseableCoroutineScope` |
| `runBlocking` в production | blocking поток, deadlock risk | `scope.launch { }` |
| `delay(N)` в тестах | реальное время, не virtual time | `advanceUntilIdle()` + debounce mocking |
| `vm.state.launchIn(scope)` | костыль вокруг `stateIn` | canonical VM pattern |

### Canonical VM pattern

```kotlin
class MyViewModel(
    private val deps: MyDeps,
    private val scope: AutoCloseableCoroutineScope = AutoCloseableCoroutineScope(),
) : ViewModel() {
    init { addCloseable(scope) }
    private val _state = MutableStateFlow<UiState>(UiState.Loading)
    val state: StateFlow<UiState> = _state.asStateFlow()
    init { scope.launch { repo.observe().collect { _state.value = it } } }
}
```

Подробности: `singularity-todo-testable-vm`, `singularity-todo-vm-migration-playbook`.

### Testing notes

**`kotlin.test.assertTrue` does NOT accept a lambda as message** — use `assertTrue(condition, "description")`.
**`import kotlin.io.path.*` bypasses detekt's `NoWildcardImports` rule** — use explicit imports
(`kotlin.io.path.exists`, `kotlin.io.path.readText`, `kotlin.io.path.isRegularFile`).
**Stale-test-classes is NOT a thing (verified 2026-10-04)** — a plain rerun after editing a test
recompiles and re-executes; `--rerun-tasks` — только отладочная костыль. ADR `2026-10-04-configuration-cache-hardening` §A3.

**Добавил `TestTag` → пересобери каталог.** `Maestro/TAGS.md` — золотой файл: его
сгенерированная часть сверяется с `TestTags.kt`, и расхождение падает в
`TestTagsCatalogJvmTest` — то есть на полном JVM-прогоне (≈40 мин). Пересборка:

```bash
./gradlew :shared:jvmTest -PupdateGoldens=true   # переписывает сгенерированную часть TAGS.md
```

`scripts/check-test-tags-catalog.py` делает ту же сверку за секунды, без JVM, —
он и стоит в гейтах; полный прогон нужен, чтобы *переписать* файл, а не чтобы
*узнать*, что он устарел.

Тесты пишутся в `shared/src/{jvmTest,commonTest}`, двойники — в
`test/fakes/FakeRepositories.kt` (fake, не моки). Скилл
`singularity-todo-test-helpers` — три формы теста; `singularity-todo-testable-vm` —
харнесс ViewModel-тестов; `singularity-todo-test-flaky-prevention` — правила, по
которым тест не становится плавающим.
