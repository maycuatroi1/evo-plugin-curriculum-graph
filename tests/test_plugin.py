"""Tests of curriculum-graph: the files the hub reads, the page's limits inside the hub's sandbox, the vendored
libraries, and the graph contract curriculum-graph/1 against a sample graph.

The page itself runs in the hub's frame; `node --check` checks its script parses when node is on the machine."""

import hashlib
import json
import re
import shutil
import subprocess
import unittest
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "pages" / "graph"
VENDOR = {
    "graphology.umd.min.js": "641ea047e2f414dead999769d62567ce3c6f1ddc334f1e728bd5edb19d337977",
    "sigma.min.js": "be6f790da9c1856765b1c430de3b1aac50433223361870edb3097a9868218a88",
}
KIT = ("/v1/plugin-ui/kit/1/evo-ui.css", "/v1/plugin-ui/kit/1/evo-ui.js")


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def check(schema, value, where="$"):
    """The subset of JSON Schema that schema/curriculum-graph-1.json uses: type, const, enum, required, properties,
    items. Returns the problems found."""
    problems = []
    types = schema.get("type")
    if types is not None:
        names = types if isinstance(types, list) else [types]
        kinds = {
            "object": dict, "array": list, "string": str, "boolean": bool, "null": type(None),
            "integer": int, "number": (int, float),
        }
        ok = any(isinstance(value, kinds[n]) and not (n in ("integer", "number") and isinstance(value, bool)) for n in names)
        if not ok:
            return [f"{where}: {type(value).__name__} is not {names}"]
    if "const" in schema and value != schema["const"]:
        problems.append(f"{where}: {value!r} is not {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        problems.append(f"{where}: {value!r} is not one of {schema['enum']}")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                problems.append(f"{where}: {key} is missing")
        for key, sub in schema.get("properties", {}).items():
            if key in value:
                problems += check(sub, value[key], f"{where}.{key}")
    if isinstance(value, list) and "items" in schema:
        for i, item in enumerate(value):
            problems += check(schema["items"], item, f"{where}[{i}]")
    return problems


class Refs(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in ("src", "href") and value:
                self.refs.append(value)


class Manifest(unittest.TestCase):
    def test_manifest(self):
        m = load(ROOT / "evo-plugin.json")
        self.assertEqual(m["id"], "curriculum-graph")
        self.assertEqual(m["tier"], "isolated")
        self.assertEqual(m["permissions"], ["records:use"], "the page needs records and nothing else")
        self.assertNotIn("backend", m, "a page-only plugin runs no backend")
        for page in m["contributes"]["pages"]:
            self.assertTrue((ROOT / page["entry"]).is_file(), page["entry"])
            self.assertTrue(page["entry"].startswith("pages/"))

    def test_market_entry_names_this_plugin(self):
        m, e = load(ROOT / "evo-plugin.json"), load(ROOT / "market-entry.json")
        self.assertEqual(e["id"], m["id"])
        self.assertEqual(e["publisher"]["id"], m["publisher"])
        self.assertEqual(e["tier"], m["tier"])
        self.assertEqual(e["publisher"]["signer"], f"sigstore:{e['repo']}/.github/workflows/ci.yml")
        self.assertLessEqual(len(e["description"]), 280)


class Page(unittest.TestCase):
    def test_loads_only_the_kit_and_its_own_files(self):
        parser = Refs()
        parser.feed((PAGE / "index.html").read_text(encoding="utf-8"))
        for ref in parser.refs:
            if ref in KIT:
                continue
            self.assertNotRegex(ref, r"^[a-z]+:|^//|^/", f"{ref}: the CSP serves only the bundle's pages/ and the kit")
            self.assertTrue((PAGE / ref).is_file(), f"{ref} is not in the bundle")

    def test_fetches_nothing_itself(self):
        script = (PAGE / "graph.js").read_text(encoding="utf-8")
        for word in ("fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "localStorage", "document.cookie"):
            self.assertNotIn(word, script, f"{word}: the frame has connect-src 'none' and an opaque origin")

    def test_writes_records_with_a_revision(self):
        script = (PAGE / "graph.js").read_text(encoding="utf-8")
        puts = re.findall(r'call\("records\.put", \{[^}]*\}', script)
        self.assertTrue(puts)
        for put in puts:
            self.assertIn("revision", put, f"{put}: every write names the revision it read")

    def test_no_middle_dot(self):
        for path in PAGE.glob("*"):
            if path.is_file():
                self.assertNotIn("·", path.read_text(encoding="utf-8"), path.name)

    def test_vendored_libraries(self):
        for name, digest in VENDOR.items():
            self.assertEqual(hashlib.sha256((PAGE / "vendor" / name).read_bytes()).hexdigest(), digest, name)
        notices = (PAGE / "vendor" / "LICENSES.txt").read_text(encoding="utf-8")
        self.assertIn("sigma 3.0.2", notices)
        self.assertIn("graphology 0.25.4", notices)

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_script_parses(self):
        subprocess.run(["node", "--check", str(PAGE / "graph.js")], check=True)


class Contract(unittest.TestCase):
    def test_sample_graph_fits_the_schema(self):
        schema = load(ROOT / "schema" / "curriculum-graph-1.json")
        graph = load(ROOT / "tests" / "fixtures" / "graph.json")
        self.assertEqual(check(schema, graph), [])

    def test_schema_catches_a_broken_graph(self):
        schema = load(ROOT / "schema" / "curriculum-graph-1.json")
        graph = load(ROOT / "tests" / "fixtures" / "graph.json")
        graph["schema"] = "curriculum-graph/2"
        del graph["nodes"][0]["x"]
        graph["edges"][0]["kind"] = "friend"
        problems = check(schema, graph)
        self.assertEqual(len(problems), 3, problems)

    def test_sample_edges_join_nodes(self):
        graph = load(ROOT / "tests" / "fixtures" / "graph.json")
        ids = {n["id"] for n in graph["nodes"]}
        for e in graph["edges"]:
            self.assertIn(e["source"], ids)
            self.assertIn(e["target"], ids)
            self.assertEqual(e["id"], f"{e['kind']}:{e['source']}>{e['target']}")


if __name__ == "__main__":
    unittest.main()
