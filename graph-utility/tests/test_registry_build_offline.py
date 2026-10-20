"""Offline test: registry auto-build activities WITHOUT Neptune/Databricks.

Uses a FakeOntologyClient returning a small schema, and checks that
derive_mappings() produces correct registry rows and run_build() sequences the
activities (fetch -> derive -> emit) with no backend adapter.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from graph_utility.descriptor import GraphSource
from graph_utility.registry_build import (
    derive_mappings, run_build, local_name, to_snake, synth_aliases,
)


class FakeOntologyClient:
    """Returns a tiny ontology schema resembling the Contract IQ graph."""

    def list_classes(self):
        return [
            {"class": "http://ontology.takeda.com/ontology/ma#Contract", "label": "Contract"},
            {"class": "http://ontology.takeda.com/ontology/ma#Supplier", "label": None},
        ]

    def list_properties(self):
        return [
            {"property": "http://ontology.takeda.com/ontology/ma#therapeuticArea",
             "label": "Therapeutic Area", "domain": None, "range": "xsd:string"},
            {"property": "http://ontology.takeda.com/ontology/ma#feesAmount",
             "label": "Fees Amount", "domain": None, "range": "xsd:double"},
            {"property": "http://ontology.takeda.com/ontology/ma#supplierName",
             "label": None, "domain": None, "range": "xsd:string"},
        ]

    def list_relationships(self):
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
        "tags": {"base_table": "dbx_cc_sow_base_attributes"},
    }).require_valid()


def main() -> int:
    # Unit checks on helpers
    assert local_name("http://x/ma#therapeuticArea") == "therapeuticArea"
    assert to_snake("therapeuticArea") == "therapeutic_area"
    assert "therapeutic area" in synth_aliases("Therapeutic Area", "therapeuticArea")

    src = _source()
    schema = {
        "classes": FakeOntologyClient().list_classes(),
        "properties": FakeOntologyClient().list_properties(),
        "relationships": [],
    }
    rows = derive_mappings(src, schema)
    by_label = {r["ontology_label"]: r for r in rows}
    print("derived rows:", [(r["ontology_label"], r["entity_type"], r["uc_column"], r["data_type"]) for r in rows])

    # Therapeutic Area -> property, snake_case column, string
    ta = by_label["Therapeutic Area"]
    assert ta["entity_type"] == "property" and ta["uc_column"] == "therapeutic_area" and ta["data_type"] == "string"
    # Fees Amount -> double + aggregatable
    fa = by_label["Fees Amount"]
    assert fa["data_type"] == "double" and fa["is_aggregatable"] is True
    # supplierName (no label) -> label prettified, column snake_cased
    sn = by_label["Supplier Name"]
    assert sn["uc_column"] == "supplier_name"
    # Class entry has NULL column
    assert by_label["Contract"]["uc_column"] is None and by_label["Contract"]["entity_type"] == "class"

    # Full pipeline without a backend adapter (fetch -> derive -> emit)
    res = run_build(src, adapter=None, ontology_client=FakeOntologyClient())
    print("\nrun_build steps:", res["steps"])
    assert res["steps"]["derive_mappings"]["rows"] == len(rows)
    assert res["descriptor"]["graph_source_id"] == "contract-iq"

    print("\nALL REGISTRY-BUILD TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
