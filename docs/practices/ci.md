# CI/CD — гейты, поверхности, ожидание

Реестр гейтов, поверхности CI и ожидание прогона — здесь, а не в `AGENTS.md`:
это справка, к которой обращаются, когда прогон уже идёт, и держать её в файле,
читаемом перед каждой задачей, — значит платить за неё дважды.

Единственный список гейтов — **реестр** (`scripts/src/sgate/commands/_registry.py` +
`scripts/src/sgate/gate_manifest.py`); `scripts/ci/static-gates.sh` и
`docs/scripts/gate-registry.md` **генерируются** из него, руками их не правь:
`PYTHONPATH=scripts/src python3 -m sgate render-static-gates --write` и
`python3 -m sgate render-registry`. Джоб `static` в `ci.yml` и `check.sh` берут
тот же реестр: гейт не может жить на одной поверхности и отсутствовать на другой.
Джоб `CI gate` в `ci.yml` — тот, что обязан быть зелёным; **branch protection на
`main` не включена**, и включается она одной строкой, когда `main` станет надёжно
зелёным:
`gh api repos/{owner}/{repo}/branches/main/protection -X PUT
-F required_status_checks='{"contexts":["CI gate"]}'` (шапка `ci.yml` говорит то
же самое). Пока защиты нет, «зелёный CI» — это соглашение, а не блокировка:
мерж проходит и с красным прогоном. Состав workflow'ев, частей A–G мета-гейта и
рецепты — скилл `singularity-todo-quality-tools`.

**Ждёшь CI — одной командой, а не циклом опроса:**

```bash
gh pr checks <pr> --watch --interval 60   # ждёт до конца, печатает вердикт
```

Десять `sleep 30 && gh pr checks` — это десять раундов контекста впустую, и
ровно то, что запрещает абзац про долгие запуски выше. `--watch` ждёт сам и
отдаёт финальный вердикт одной строкой.

**Лог упавшей джобы — через API, а не через `gh run view`.** На живом ране
`gh run view --log-failed` отвечает «run is still in progress» — за причиной
падения приходится ждать конца всего рана. Лог джобы доступен сразу:

```bash
gh api repos/gazon1/sing/actions/jobs/<job-id>/logs      # лог конкретной джобы
```

Номер джобы — в выводе `gh pr checks <pr>`; в URL джобы он последний.

**Один `--watch` на PR — и никаких снимков рядом с ним.** Пока идёт `--watch`,
состояние не снимают: `gh pr checks` для «как там» — это тот же цикл опроса,
только тише. Дорогой локальный прогон — тоже: `python3 -m unittest discover -s
scripts/tests` (≈2,5 мин) запускают **один раз**, пишут вывод в файл и читают
сводку по совпадениям, а не гоняют заново ради второго вопроса.

Свойства прогона — в `gradle.properties` и в `config/test-populations.properties`;
`scripts/scanning.py` — сканер тестов (классы, теги, наборы). Реестр гейтов —
`scripts/src/sgate/commands/_registry.py` + `scripts/src/sgate/gate_manifest.py`.
