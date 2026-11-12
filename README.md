# evo-plugin-curriculum-graph

The hub plugin `curriculum-graph` of [evo-agents](https://github.com/maycuatroi1/evo-agents). It adds a page,
"Bản đồ môn học", to a project: the courses of a curriculum drawn as a graph with one column per semester, the
relations between them, the details of each course, and the problems and comments the project marks on the graph.
Members click a course or a relation to read it, and add, answer and resolve problems and comments in place.

The plugin carries no curriculum. The project's harness builds the graph from its own files and pushes it; the
first user is the harness `fu-security-development-harness`, whose `scripts/build_curriculum_graph.py` reads
`curriculum/` and the review of its draft.

## What the page shows

- **Nodes**: one per course, coloured by the group the harness gives it, sized by credits. A code that is named as a
  prerequisite but missing from the catalog, or a course merged into another, is drawn grey.
- **Edges**: prerequisite, co-requisite, hand-off of a product from one course to the next, support or
  recommendation, merge, and two kinds a review finds: overlapping content and an implicit dependency. Each edge
  keeps the source words it rests on and says whether they come from the curriculum or from the review (observed,
  inferred, not verified).
- **Problems and comments**: a ring around a course and a badge with the count of open items, red for problems,
  violet for comments, green when everything is resolved. A badge on an edge shows while its edge is in focus.
- **Panel**: the overview of every open item grouped by what it needs (a decision, a text fix, evidence), a course's
  facts, relations and syllabus (CLOs, weekly plan, assessment, materials), a relation's evidence, and each item's
  thread with replies, resolve and reopen.

Hover a course to see what it connects to. A sub path opens a course: `/p/<project>/x/curriculum-graph/graph/SAI302`.

## Records

The plugin asks for one permission, `records:use`, and has no backend. The page reads and writes the project's
records of the plugin through the bridge `evo-plugin/1` with the viewer's own session, so the hub applies the
viewer's grant to every call: readers read, writers write.

| Collection | Key | Body |
| --- | --- | --- |
| `graph` | `current` | `{build, parts, bytes, schema, commit, builtAt}`: the build the page shows |
| `graph` | `<build>-000`, `<build>-001`, ... | `{i, data}`: a part of the graph's JSON; the parts joined in order are one curriculum-graph/1 document. A record holds at most 64 KiB, so a graph of a whole programme comes in a few parts |
| `threads` | an id: a backlog id such as `CUR-20`, or `v-<time>-<random>` for one a member added | `{type: problem \| comment, title, body, targets[], status: open \| resolved, category, source, origin, author, createdAt, resolvedBy, resolvedAt, resolution, replies[]}` |

A target is `node:<code>`, `edge:<kind>:<source>><target>` or `program`. A reply is `{id, by, at, action: reply |
resolve | reopen, body}`. Every write of a thread names the revision it read; on a 409 the page reads the thread
again and applies the change once more, so two people answering at once both land.

The harness writes the same records with a member's token on the member API,
`/v1/projects/<project>/plugins/curriculum-graph/records/<collection>/<key>`: it puts the parts first, then
`current`, then deletes the parts of older builds, so the page never reads half a build.

## curriculum-graph/1

`schema/curriculum-graph-1.json` is the contract between this plugin (owner) and a harness that pushes a graph
(consumer). `tests/fixtures/graph.json` is a small complete example. The keys the page reads: `title`, `subtitle`,
`badge`, `builtAt`, `commit`, `program {title, summary}`, `columns[]` (`semester`, `x`, `courses`, `credits`,
`blank`), `legend` (groups and their colour slot `s1` to `s5`, the focus group, the words of each kind of relation
and of each category), `nodes[]` and `edges[]`.

## Develop

```sh
python3 -m unittest discover -s tests -v   # manifest, page limits, vendored files, the contract
evo-agents plugin test .                   # the conformance checks a hub relies on
```

The page runs only inside the hub's frame (`sandbox="allow-scripts allow-forms"`, `connect-src 'none'`), so it loads
nothing but its own files and the hub's UI kit 1. sigma 3.0.2 and graphology 0.25.4 sit in `pages/graph/vendor/`
with their MIT notices; the tests pin their SHA-256.

## Release

The CI tests and packs on every push and pull request, and signs the bundle keyless with Sigstore on `main` and on a
tag `vX.Y.Z`; a tag also makes the GitHub Release a hub installs from. A hub admin trusts the signer once:

```sh
evo-agents hub plugin publisher add maycuatroi1 sigstore:maycuatroi1/evo-plugin-curriculum-graph/.github/workflows/ci.yml
evo-agents hub plugin install --github maycuatroi1/evo-plugin-curriculum-graph@v0.1.0
evo-agents hub plugin enable curriculum-graph --project <project>
```

## License

Apache-2.0. The vendored sigma and graphology are MIT, see `pages/graph/vendor/LICENSES.txt`.
