"""Offline test: exercise the generic OMDA engine WITHOUT Databricks/Neptune.

Uses a MockAdapter that serves a tiny in-memory mapping registry and fakes SQL
execution, so we can validate descriptor loading, concept extraction, filter
detection, and SQL generation end-to-end in any Python environment.

Run:  python -m tests.test_engine_offline   (from the src/ dir on PYTHONPATH)
or:   python tests/test_engine_offline.py
"""
from __future__ import annotations

import os
import sys

# Make the package importable when run directly.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from graph_utility.descriptor import GraphSource
from graph_utility.backends import BackendAdapter
from graph_utility.engine import OMDAEngine


# A tiny registry resembling the Contract IQ mappings (subset).
MOCK_REGISTRY = [
    {"ontology_uri": "ma#Contract", "ontology_label": "Contract", "entity_type": "class",
     "uc_table": "dbx_cc_sow_base_attributes", "uc_column": None, "join_key": "contract_key",
     "data_type": None, "search_aliases": "contract|agreement|SOW", "is_filterable": True, "is_aggregatable": False},
    {"ontology_uri": "ma#supplierName", "ontology_label": "Supplier Name", "entity_type": "property",
     "uc_table": "dbx_cc_sow_base_attributes", "uc_column": "supplier_name", "join_key": "contract_key",
     "data_type": "string", "search_aliases": "supplier|vendor|provider name", "is_filterable": True, "is_aggregatable": False},
    {"ontology_uri": "ma#therapeuticArea", "ontology_label": "Therapeutic Area", "entity_type": "property",
     "uc_table": "dbx_cc_sow_analytical_attributes", "uc_column": "therapeutic_area", "join_key": "contract_key",
     "data_type": "string", "search_aliases": "therapeutic area|therapy area|TA|disease area", "is_filterable": True, "is_aggregatable": False},
    {"ontology_uri": "ma#feesAmount", "ontology_label": "Fees Amount", "entity_type": "property",
     "uc_table": "dbx_cc_sow_base_fees_output", "uc_column": "fees_amount", "join_key": "contract_key",
     "data_type": "double", "search_aliases": "fees amount|fee value|cost", "is_filterable": True, "is_aggregatable": True},
]


class MockAdapter(BackendAdapter):
    def load_registry(self):
        return MOCK_REGISTRY

    def execute_sql(self, sql, limit):
        return {"columns": ["supplier_name", "therapeutic_area"],
                "rows": [{"supplier_name": "IQVIA", "therapeutic_area": "Oncology"}],
                "row_count": 1}

    def vector_search(self, query, num_results, filters=None):
        return []


def _source() -> GraphSource:
    return GraphSource.from_dict({
        "graph_source_id": "contract-iq",
        "bu": "market-access",
        "display_name": "Contract IQ",
        "ontology": {"type": "neptune", "sparql_url": "https://x:8182/sparql",
                     "graph_uri": "http://g", "namespace": "http://ontology.takeda.com/ontology/ma#"},
        "backend": {"type": "databricks-uc", "catalog": "usdev_corp", "schema": "corp_us_mart",
                    "registry_table": "usdev_corp.corp_us_mart.omda_ontology_mapping",
                    "universal_join_key": "contract_key"},
        "llm_endpoint": "databricks-meta-llama-3-3-70b-instruct",
    }).require_valid()


def main() -> int:
    src = _source()
    engine = OMDAEngine(src, MockAdapter(src))
    failures = 0

    # 1) dry-run SQL generation with a filter
    r = engine.answer("What is the therapeutic area for contracts with supplier IQVIA?", dry_run=True)
    print("Q1 concepts:", r["concepts"])
    print("Q1 filters :", r["filters"])
    print("Q1 SQL:\n", r["sql"])
    assert "Therapeutic Area" in r["concepts"], "therapeutic area concept missing"
    assert r["filters"].get("Supplier Name", "").lower() == "iqvia", f"supplier filter wrong: {r['filters']}"
    assert "LEFT JOIN" in r["sql"] and "ILIKE" in r["sql"], "SQL join/filter missing"
    assert "contract_key" in r["sql"], "join key missing"

    # 2) multi-select, no filter
    r2 = engine.answer("List supplier name and therapeutic area", dry_run=True)
    print("\nQ2 SQL:\n", r2["sql"])
    assert "supplier_name" in r2["sql"] and "therapeutic_area" in r2["sql"]

    # 3) analytical intent: "by" is GROUP BY, not a value filter
    r3 = engine.answer("total fees amount by supplier name", dry_run=True)
    print("\nQ3 aggregate SQL:\n", r3["sql"])
    assert r3["filters"] == {}, f"grouping phrase became a filter: {r3['filters']}"
    assert "Therapeutic Area" not in r3["concepts"], "short alias TA matched inside another word"
    assert "SUM(" in r3["sql"] and "GROUP BY" in r3["sql"], "SUM/GROUP BY missing"
    assert "ILIKE '%name%'" not in r3["sql"], "spurious supplier-name filter present"

    r4 = engine.answer("average fees amount by supplier name", dry_run=True)
    assert "AVG(" in r4["sql"] and "GROUP BY" in r4["sql"], "AVG/GROUP BY missing"

    r5 = engine.answer("count contracts by supplier name", dry_run=True)
    assert "COUNT(*)" in r5["sql"] and "GROUP BY" in r5["sql"], "COUNT/GROUP BY missing"

    # 4) execution path (mock)
    r6 = engine.answer("supplier name for oncology", limit=5)
    print("\nQ6 rows:", r6.get("rows"), "count:", r6.get("row_count"))
    assert r6.get("row_count") == 1

    # 5) no-concept question handled gracefully
    r7 = engine.answer("what is the weather today", dry_run=True)
    assert r7.get("error"), "expected graceful error for no-concept question"
    print("\nQ7 handled:", r7["error"])

    print("\nALL OFFLINE ENGINE TESTS PASSED")
    return failures


if __name__ == "__main__":
    sys.exit(main())
