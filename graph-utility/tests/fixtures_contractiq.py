"""ContractIQ-shaped fixture built to SEPARATE two mapping methods.

Why this exists. The question is whether mapping from metadata alone — table
and column names, comments, types, optionally an LLM, which is what OntoBricks
documents — is as good as mapping from measured evidence: proven key uniqueness
and measured value overlap. On a clean schema both methods agree, so a clean
schema cannot answer it.

So every table here carries a decision that metadata gets wrong or cannot make,
each drawn from something lakehouses really contain:

  T1  `site` has NO declared primary key, but `site_id` IS unique.
      Metadata can only see the absence of a key, so a correct mapping is lost.
      Measurement proves identity and recovers it.          -> recall

  T2  `contract_therapeutic_area` has no declared key, and `contract_id` LOOKS
      like one (`*_id`, non-null, first column) but is NOT unique — a contract
      spans several areas. Only (contract_id, ta_code) identifies a row.
      Name shape picks the single column and silently collapses rows.
                                                             -> precision

  T3  Two plausible parents: `site` and `site_archive`, same column `site_id`,
      similar names, no declared FK. `contract.site_ref` really references
      `site` (every value present) and only brushes `site_archive` (2 of 6).
      Name similarity cannot tell them apart; containment can.
                                                             -> precision

  T4  `contract.supplier_id -> supplier.supplier_id` IS a declared FK.
      Both methods must get this. A comparison where the baseline can never
      win is not a comparison, so the control cases are here on purpose.

  T5  Plain datatype properties with exact name matches, which both methods
      map correctly.

Row counts are tiny and the values are synthetic, but the overlap and
uniqueness numbers are REAL: `overlap.py` has a generic fallback that measures
through `DataAdapter.execute`, so the in-memory adapter is measured exactly the
way Unity Catalog is, just without a warehouse. Nothing here is simulated.

stdlib only.
"""
from __future__ import annotations

from graph_utility.data_adapter import InMemoryDataAdapter, InMemoryTable
from graph_utility.discovery import (
    ColumnMetadata,
    JoinMetadata,
    KeyMetadata,
    KeyType,
    LogicalType,
    TableMetadata,
)

NS = "http://ontology.takeda.com/ontology/ciq#"


# --------------------------------------------------------------------------- #
# Tables
# --------------------------------------------------------------------------- #
def contractiq_tables() -> list[InMemoryTable]:
    contract = InMemoryTable(
        metadata=TableMetadata(
            name="contract",
            columns=(
                ColumnMetadata("contract_id", LogicalType.STRING, nullable=False),
                ColumnMetadata("supplier_id", LogicalType.STRING),
                # T3: references `site`, named so that neither `site` nor
                # `site_archive` wins on name similarity.
                ColumnMetadata("site_ref", LogicalType.STRING),
                ColumnMetadata("status", LogicalType.STRING),
                ColumnMetadata("start_date", LogicalType.DATE),
                ColumnMetadata("fees_amount", LogicalType.DECIMAL),
            ),
            keys=(KeyMetadata(KeyType.PRIMARY, ("contract_id",), name="pk_contract"),),
            comment="Executed supplier contracts",
        ),
        rows=[
            {"contract_id": "C-1", "supplier_id": "S-1", "site_ref": "SITE-1",
             "status": "active", "start_date": "2026-01-05", "fees_amount": 120000.0},
            {"contract_id": "C-2", "supplier_id": "S-1", "site_ref": "SITE-2",
             "status": "active", "start_date": "2026-02-11", "fees_amount": 64000.0},
            {"contract_id": "C-3", "supplier_id": "S-2", "site_ref": "SITE-3",
             "status": "expired", "start_date": "2025-06-30", "fees_amount": 310000.0},
            {"contract_id": "C-4", "supplier_id": "S-3", "site_ref": "SITE-1",
             "status": "active", "start_date": "2026-03-02", "fees_amount": 88000.0},
            {"contract_id": "C-5", "supplier_id": "S-2", "site_ref": "SITE-4",
             "status": "pending", "start_date": "2026-04-19", "fees_amount": 45000.0},
            {"contract_id": "C-6", "supplier_id": "S-3", "site_ref": "SITE-5",
             "status": "active", "start_date": "2026-05-23", "fees_amount": 150000.0},
        ],
    )

    supplier = InMemoryTable(
        metadata=TableMetadata(
            name="supplier",
            columns=(
                ColumnMetadata("supplier_id", LogicalType.STRING, nullable=False),
                ColumnMetadata("supplier_name", LogicalType.STRING),
                ColumnMetadata("country", LogicalType.STRING),
            ),
            keys=(KeyMetadata(KeyType.PRIMARY, ("supplier_id",), name="pk_supplier"),),
            comment="Contracted suppliers",
        ),
        rows=[
            {"supplier_id": "S-1", "supplier_name": "Meridian Health", "country": "US"},
            {"supplier_id": "S-2", "supplier_name": "Nordic Pharma", "country": "SE"},
            {"supplier_id": "S-3", "supplier_name": "Kyoto Biologics", "country": "JP"},
        ],
    )

    # T1: no declared PK. site_id IS unique, which only measurement can show.
    site = InMemoryTable(
        metadata=TableMetadata(
            name="site",
            columns=(
                ColumnMetadata("site_id", LogicalType.STRING, nullable=False),
                ColumnMetadata("site_name", LogicalType.STRING),
                ColumnMetadata("country", LogicalType.STRING),
                ColumnMetadata("active", LogicalType.BOOLEAN),
            ),
            keys=(),
            comment="Delivery sites",
        ),
        rows=[
            {"site_id": "SITE-1", "site_name": "Boston Hub", "country": "US", "active": True},
            {"site_id": "SITE-2", "site_name": "Uppsala Hub", "country": "SE", "active": True},
            {"site_id": "SITE-3", "site_name": "Osaka Hub", "country": "JP", "active": False},
            {"site_id": "SITE-4", "site_name": "Boston Hub", "country": "US", "active": True},
            {"site_id": "SITE-5", "site_name": "Lyon Hub", "country": "FR", "active": True},
        ],
    )

    # T3: the decoy. Same key column, similar name, mostly disjoint values.
    site_archive = InMemoryTable(
        metadata=TableMetadata(
            name="site_archive",
            columns=(
                ColumnMetadata("site_id", LogicalType.STRING, nullable=False),
                ColumnMetadata("site_name", LogicalType.STRING),
                ColumnMetadata("retired_on", LogicalType.DATE),
            ),
            keys=(),
            comment="Retired delivery sites, kept for audit",
        ),
        rows=[
            {"site_id": "SITE-1", "site_name": "Boston Hub", "retired_on": "2024-02-01"},
            {"site_id": "SITE-2", "site_name": "Uppsala Hub", "retired_on": "2024-07-14"},
            {"site_id": "SITE-90", "site_name": "Porto Hub", "retired_on": "2023-11-09"},
            {"site_id": "SITE-91", "site_name": "Cork Hub", "retired_on": "2023-12-20"},
        ],
    )

    therapeutic_area = InMemoryTable(
        metadata=TableMetadata(
            name="therapeutic_area",
            columns=(
                ColumnMetadata("ta_code", LogicalType.STRING, nullable=False),
                ColumnMetadata("ta_name", LogicalType.STRING),
            ),
            keys=(KeyMetadata(KeyType.PRIMARY, ("ta_code",), name="pk_ta"),),
            comment="Therapeutic areas",
        ),
        rows=[
            {"ta_code": "ONC", "ta_name": "Oncology"},
            {"ta_code": "NEU", "ta_name": "Neuroscience"},
            {"ta_code": "GAS", "ta_name": "Gastroenterology"},
        ],
    )

    # T2: no declared key; contract_id alone is NOT unique.
    contract_ta = InMemoryTable(
        metadata=TableMetadata(
            name="contract_therapeutic_area",
            columns=(
                ColumnMetadata("contract_id", LogicalType.STRING, nullable=False),
                ColumnMetadata("ta_code", LogicalType.STRING, nullable=False),
                ColumnMetadata("allocation_pct", LogicalType.DECIMAL),
            ),
            keys=(),
            comment="Which therapeutic areas a contract covers",
        ),
        rows=[
            {"contract_id": "C-1", "ta_code": "ONC", "allocation_pct": 60.0},
            {"contract_id": "C-1", "ta_code": "NEU", "allocation_pct": 40.0},
            {"contract_id": "C-2", "ta_code": "ONC", "allocation_pct": 100.0},
            {"contract_id": "C-3", "ta_code": "GAS", "allocation_pct": 50.0},
            {"contract_id": "C-3", "ta_code": "NEU", "allocation_pct": 50.0},
            {"contract_id": "C-6", "ta_code": "ONC", "allocation_pct": 100.0},
        ],
    )

    return [contract, supplier, site, site_archive, therapeutic_area, contract_ta]


def contractiq_declared_joins() -> list[JoinMetadata]:
    """Only T4 is declared. Everything else must be earned or lost."""
    return [
        JoinMetadata("contract", ("supplier_id",), "supplier", ("supplier_id",),
                     cardinality="many-to-one", origin="declared",
                     name="fk_contract_supplier"),
    ]


def contractiq_adapter() -> InMemoryDataAdapter:
    return InMemoryDataAdapter(
        source_id="contract-iq",
        tables=contractiq_tables(),
        joins=contractiq_declared_joins(),
    )


# --------------------------------------------------------------------------- #
# Ontology (the supplied schema both methods map FROM)
# --------------------------------------------------------------------------- #
def contractiq_ontology() -> dict[str, list[dict]]:
    return {
        "classes": [
            {"class": NS + "Contract", "label": "Contract"},
            {"class": NS + "Supplier", "label": "Supplier"},
            {"class": NS + "Site", "label": "Site"},
            {"class": NS + "TherapeuticArea", "label": "Therapeutic Area"},
            {"class": NS + "ContractTherapeuticArea",
             "label": "Contract Therapeutic Area"},
        ],
        "properties": [
            {"property": NS + "status", "label": "Status",
             "domain": NS + "Contract", "range": "xsd:string",
             "ptype": "owl:DatatypeProperty"},
            {"property": NS + "startDate", "label": "Start Date",
             "domain": NS + "Contract", "range": "xsd:date",
             "ptype": "owl:DatatypeProperty"},
            {"property": NS + "feesAmount", "label": "Fees Amount",
             "domain": NS + "Contract", "range": "xsd:decimal",
             "ptype": "owl:DatatypeProperty"},
            {"property": NS + "supplierName", "label": "Supplier Name",
             "domain": NS + "Supplier", "range": "xsd:string",
             "ptype": "owl:DatatypeProperty"},
            {"property": NS + "siteName", "label": "Site Name",
             "domain": NS + "Site", "range": "xsd:string",
             "ptype": "owl:DatatypeProperty"},
            {"property": NS + "taName", "label": "Ta Name",
             "domain": NS + "TherapeuticArea", "range": "xsd:string",
             "ptype": "owl:DatatypeProperty"},
            {"property": NS + "allocationPct", "label": "Allocation Pct",
             "domain": NS + "ContractTherapeuticArea", "range": "xsd:decimal",
             "ptype": "owl:DatatypeProperty"},
        ],
        "relationships": [
            # T4 — declared FK. Both methods should get this.
            {"property": NS + "hasSupplier", "label": "Supplier",
             "domain": NS + "Contract", "range": NS + "Supplier"},
            # T3 — no declared FK, two plausible parents.
            {"property": NS + "deliveredAtSite", "label": "Site",
             "domain": NS + "Contract", "range": NS + "Site"},
            # T2 — junction edges, no declared keys on either side of the hop.
            {"property": NS + "coversArea", "label": "Therapeutic Area",
             "domain": NS + "ContractTherapeuticArea",
             "range": NS + "TherapeuticArea"},
        ],
    }


# --------------------------------------------------------------------------- #
# Ground truth
# --------------------------------------------------------------------------- #
#: The mapping a careful data engineer who KNOWS this schema would publish.
#: Scoring is against this, not against either method's own confidence — a
#: method that is confidently wrong must score worse, not better.
CONTRACTIQ_TRUTH: dict[str, dict] = {
    # --- classes: ontology class -> (table, subject key) ---
    NS + "Contract": {"kind": "class", "table": "contract",
                      "subject_columns": ("contract_id",), "trap": "T4"},
    NS + "Supplier": {"kind": "class", "table": "supplier",
                      "subject_columns": ("supplier_id",), "trap": "T4"},
    NS + "Site": {"kind": "class", "table": "site",
                  "subject_columns": ("site_id",), "trap": "T1"},
    NS + "TherapeuticArea": {"kind": "class", "table": "therapeutic_area",
                             "subject_columns": ("ta_code",), "trap": "T4"},
    NS + "ContractTherapeuticArea": {
        "kind": "class", "table": "contract_therapeutic_area",
        # The composite. A single-column key here is WRONG, not merely weaker.
        "subject_columns": ("contract_id", "ta_code"), "trap": "T2"},

    # --- datatype properties: property -> (table, column) ---
    NS + "status": {"kind": "direct", "table": "contract",
                    "column": "status", "trap": "T5"},
    NS + "startDate": {"kind": "direct", "table": "contract",
                       "column": "start_date", "trap": "T5"},
    NS + "feesAmount": {"kind": "direct", "table": "contract",
                        "column": "fees_amount", "trap": "T5"},
    NS + "supplierName": {"kind": "direct", "table": "supplier",
                          "column": "supplier_name", "trap": "T5"},
    NS + "siteName": {"kind": "direct", "table": "site",
                      "column": "site_name", "trap": "T5"},
    NS + "taName": {"kind": "direct", "table": "therapeutic_area",
                    "column": "ta_name", "trap": "T5"},
    NS + "allocationPct": {"kind": "direct", "table": "contract_therapeutic_area",
                           "column": "allocation_pct", "trap": "T5"},

    # --- relationships: property -> the join that is actually right ---
    NS + "hasSupplier": {"kind": "relationship", "left_table": "contract",
                         "left_columns": ("supplier_id",),
                         "right_table": "supplier",
                         "right_columns": ("supplier_id",), "trap": "T4"},
    NS + "deliveredAtSite": {"kind": "relationship", "left_table": "contract",
                             "left_columns": ("site_ref",),
                             "right_table": "site",
                             "right_columns": ("site_id",), "trap": "T3"},
    NS + "coversArea": {"kind": "relationship",
                        "left_table": "contract_therapeutic_area",
                        "left_columns": ("ta_code",),
                        "right_table": "therapeutic_area",
                        "right_columns": ("ta_code",), "trap": "T2"},
}

#: What each trap is testing, for the report.
TRAP_NOTES: dict[str, str] = {
    "T1": "no declared PK, but the column is genuinely unique",
    "T2": "no declared key; the *_id-shaped single column is NOT unique",
    "T3": "two plausible parents; only value containment distinguishes them",
    "T4": "declared key or FK — both methods should succeed",
    "T5": "plain name match — both methods should succeed",
}
