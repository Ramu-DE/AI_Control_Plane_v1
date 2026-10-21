"""Neutral offline fixtures for precision-path tests.

Two STRUCTURALLY DIFFERENT fixtures prove the precision path makes no
ContractIQ-specific assumptions:

  1. clinical_trial_fixture() — a clinical-trials schema with:
       - a composite primary key (trial_site: trial_id + site_id)
       - a many-to-many relationship (trial <-> investigator via trial_site)
       - NO universal join key (joins come from real foreign keys)
     plus a matching ontology schema (classes, datatype & object properties).

  2. The ContractIQ-style schema is deliberately NOT reused here; tests assert
     that none of the ContractIQ column names (contract_key, supplier_name,
     therapeutic_area, fees_amount) ever appear in discovery, proposals, or
     compiled SQL for the clinical fixture.

A small unstructured-retrieval fixture (abstracts) exercises the Retriever seam
with a descriptor-driven field mapping (no ContractIQ columns).

stdlib only.
"""
from __future__ import annotations

from graph_utility.discovery import (
    ColumnMetadata, KeyMetadata, KeyType, JoinMetadata, LogicalType, TableMetadata,
)
from graph_utility.data_adapter import InMemoryDataAdapter, InMemoryTable
from graph_utility.retriever import FieldMapping, InMemoryRetriever


# Column names deliberately unrelated to ContractIQ.
CONTRACTIQ_COLUMNS = {"contract_key", "supplier_name", "therapeutic_area", "fees_amount"}
CONTRACTIQ_TABLES = {
    "dbx_cc_sow_base_attributes", "dbx_cc_sow_analytical_attributes",
    "dbx_cc_sow_base_fees_output",
}


# --------------------------------------------------------------------------- #
# Structured fixture: clinical trials (composite PK + many-to-many)
# --------------------------------------------------------------------------- #
def clinical_trial_tables() -> list[InMemoryTable]:
    trial = TableMetadata(
        name="trial",
        columns=(
            ColumnMetadata("trial_id", LogicalType.STRING, nullable=False),
            ColumnMetadata("trial_title", LogicalType.STRING),
            ColumnMetadata("phase", LogicalType.STRING),
            ColumnMetadata("enrollment_target", LogicalType.INTEGER),
        ),
        keys=(KeyMetadata(KeyType.PRIMARY, ("trial_id",), name="pk_trial"),),
    )
    investigator = TableMetadata(
        name="investigator",
        columns=(
            ColumnMetadata("investigator_id", LogicalType.STRING, nullable=False),
            ColumnMetadata("investigator_name", LogicalType.STRING),
            ColumnMetadata("specialty", LogicalType.STRING),
        ),
        keys=(KeyMetadata(KeyType.PRIMARY, ("investigator_id",), name="pk_inv"),),
    )
    site = TableMetadata(
        name="site",
        columns=(
            ColumnMetadata("site_id", LogicalType.STRING, nullable=False),
            ColumnMetadata("site_name", LogicalType.STRING),
            ColumnMetadata("country", LogicalType.STRING),
        ),
        keys=(KeyMetadata(KeyType.PRIMARY, ("site_id",), name="pk_site"),),
    )
    # Junction table: composite PK (trial_id + site_id), two FKs, plus a measure.
    trial_site = TableMetadata(
        name="trial_site",
        columns=(
            ColumnMetadata("trial_id", LogicalType.STRING, nullable=False),
            ColumnMetadata("site_id", LogicalType.STRING, nullable=False),
            ColumnMetadata("investigator_id", LogicalType.STRING, nullable=False),
            ColumnMetadata("enrolled_count", LogicalType.INTEGER),
        ),
        keys=(
            KeyMetadata(KeyType.PRIMARY, ("trial_id", "site_id"), name="pk_trial_site"),
            KeyMetadata(KeyType.FOREIGN, ("trial_id",), name="fk_ts_trial",
                        references_table="trial", references_columns=("trial_id",)),
            KeyMetadata(KeyType.FOREIGN, ("site_id",), name="fk_ts_site",
                        references_table="site", references_columns=("site_id",)),
            KeyMetadata(KeyType.FOREIGN, ("investigator_id",), name="fk_ts_inv",
                        references_table="investigator",
                        references_columns=("investigator_id",)),
        ),
    )

    return [
        InMemoryTable(trial, [
            {"trial_id": "T1", "trial_title": "Oncology Phase II Study",
             "phase": "II", "enrollment_target": 120},
            {"trial_id": "T2", "trial_title": "Cardio Phase III Study",
             "phase": "III", "enrollment_target": 300},
        ]),
        InMemoryTable(investigator, [
            {"investigator_id": "I1", "investigator_name": "Dr Reyes", "specialty": "Oncology"},
            {"investigator_id": "I2", "investigator_name": "Dr Okafor", "specialty": "Cardiology"},
        ]),
        InMemoryTable(site, [
            {"site_id": "S1", "site_name": "North Clinic", "country": "US"},
            {"site_id": "S2", "site_name": "South Clinic", "country": "BR"},
        ]),
        InMemoryTable(trial_site, [
            {"trial_id": "T1", "site_id": "S1", "investigator_id": "I1", "enrolled_count": 40},
            {"trial_id": "T1", "site_id": "S2", "investigator_id": "I1", "enrolled_count": 35},
            {"trial_id": "T2", "site_id": "S1", "investigator_id": "I2", "enrolled_count": 200},
        ]),
    ]


def clinical_trial_declared_joins() -> list[JoinMetadata]:
    """Declared joins from the junction FKs. Note trial<->investigator is
    many-to-many *through* trial_site; there is NO single universal join key."""
    return [
        JoinMetadata("trial_site", ("trial_id",), "trial", ("trial_id",),
                     cardinality="many-to-one", origin="declared", name="ts_to_trial"),
        JoinMetadata("trial_site", ("site_id",), "site", ("site_id",),
                     cardinality="many-to-one", origin="declared", name="ts_to_site"),
        JoinMetadata("trial_site", ("investigator_id",), "investigator",
                     ("investigator_id",), cardinality="many-to-one",
                     origin="declared", name="ts_to_investigator"),
    ]


def clinical_trial_adapter() -> InMemoryDataAdapter:
    return InMemoryDataAdapter(
        source_id="clinical-trials",
        tables=clinical_trial_tables(),
        joins=clinical_trial_declared_joins(),
    )


def clinical_trial_ontology() -> dict[str, list[dict]]:
    """Neutral ontology schema for the clinical fixture. Namespace ct#."""
    ns = "http://example.org/ontology/ct#"
    return {
        "classes": [
            {"class": ns + "Trial", "label": "Trial"},
            {"class": ns + "Investigator", "label": "Investigator"},
            {"class": ns + "Site", "label": "Site"},
            {"class": ns + "TrialSite", "label": "Trial Site"},
        ],
        "properties": [
            {"property": ns + "trialTitle", "label": "Trial Title",
             "domain": ns + "Trial", "range": "xsd:string", "ptype": "owl:DatatypeProperty"},
            {"property": ns + "phase", "label": "Phase",
             "domain": ns + "Trial", "range": "xsd:string", "ptype": "owl:DatatypeProperty"},
            {"property": ns + "enrollmentTarget", "label": "Enrollment Target",
             "domain": ns + "Trial", "range": "xsd:integer", "ptype": "owl:DatatypeProperty"},
            {"property": ns + "investigatorName", "label": "Investigator Name",
             "domain": ns + "Investigator", "range": "xsd:string", "ptype": "owl:DatatypeProperty"},
            {"property": ns + "specialty", "label": "Specialty",
             "domain": ns + "Investigator", "range": "xsd:string", "ptype": "owl:DatatypeProperty"},
            {"property": ns + "siteName", "label": "Site Name",
             "domain": ns + "Site", "range": "xsd:string", "ptype": "owl:DatatypeProperty"},
            {"property": ns + "country", "label": "Country",
             "domain": ns + "Site", "range": "xsd:string", "ptype": "owl:DatatypeProperty"},
            {"property": ns + "enrolledCount", "label": "Enrolled Count",
             "domain": ns + "TrialSite", "range": "xsd:integer", "ptype": "owl:DatatypeProperty"},
        ],
        "relationships": [
            # Trial <-> Site via trial_site (resolvable to a discovered join).
            {"property": ns + "conductedAtSite", "label": "Site",
             "domain": ns + "TrialSite", "range": "xsd:string"},
            {"property": ns + "forTrial", "label": "Trial",
             "domain": ns + "TrialSite", "range": "xsd:string"},
        ],
    }


# --------------------------------------------------------------------------- #
# Unstructured fixture: trial abstracts (descriptor-driven field mapping)
# --------------------------------------------------------------------------- #
def abstract_field_mapping() -> FieldMapping:
    # Native index columns are NEUTRAL (doc_id, body, relevance, ...), proving
    # the retriever is descriptor-driven, not ContractIQ-shaped.
    return FieldMapping(
        id_field="doc_id",
        text_field="body",
        score_field="relevance",
        metadata_fields=("trial_id", "country"),
        rename={"trial_id": "trial"},
    )


def abstract_records() -> list[dict]:
    return [
        {"doc_id": "D1", "body": "Phase II oncology trial enrolling adult patients",
         "trial_id": "T1", "country": "US"},
        {"doc_id": "D2", "body": "Cardiology phase III trial across multiple sites",
         "trial_id": "T2", "country": "BR"},
        {"doc_id": "D3", "body": "Oncology study investigator site enrollment update",
         "trial_id": "T1", "country": "US"},
    ]


def abstract_retriever(name: str = "abstracts") -> InMemoryRetriever:
    return InMemoryRetriever(name, abstract_records(), abstract_field_mapping())
