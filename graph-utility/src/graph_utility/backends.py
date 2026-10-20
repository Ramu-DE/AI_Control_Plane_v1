"""Backend adapters — the data-plane seam.

The engine is backend-agnostic: it asks an adapter to (a) load the mapping
registry for a GraphSource, (b) execute generated SQL, and (c) do vector search.
Today only the Databricks/Unity Catalog adapter is implemented. Qdrant /
Bedrock-KB / warehouse adapters can be added later WITHOUT changing the engine.

Heavy deps (pyspark, databricks-vectorsearch) are imported lazily inside the UC
adapter so this module imports cleanly in any environment (incl. tooling/tests).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Optional

from .descriptor import GraphSource


class BackendAdapter(ABC):
    """Contract every data backend must satisfy for the OMDA engine."""

    def __init__(self, source: GraphSource) -> None:
        self.source = source

    @abstractmethod
    def load_registry(self) -> list[dict[str, Any]]:
        """Return the mapping-registry rows for this GraphSource.

        Each row: ontology_uri, ontology_label, entity_type, uc_table,
        uc_column, join_key, data_type, search_aliases, is_filterable,
        is_aggregatable (column names are backend-neutral).
        """

    @abstractmethod
    def execute_sql(self, sql: str, limit: int) -> dict[str, Any]:
        """Execute generated SQL; return {'columns': [...], 'rows': [ {...} ], 'row_count': n}."""

    @abstractmethod
    def vector_search(
        self, query: str, num_results: int, filters: Optional[dict] = None
    ) -> list[dict[str, Any]]:
        """Return relevant text chunks (empty list if unsupported/unavailable)."""


class DatabricksUCAdapter(BackendAdapter):
    """Unity Catalog + Databricks Vector Search adapter.

    Expects a live Spark session (Databricks runtime / Databricks Connect).
    Pass one in, or let it resolve the active session lazily.
    """

    def __init__(self, source: GraphSource, spark: Any = None) -> None:
        super().__init__(source)
        self._spark = spark
        self._vs_index = None

    # --- spark resolution (lazy) ---
    @property
    def spark(self):
        if self._spark is None:
            try:
                from pyspark.sql import SparkSession

                self._spark = SparkSession.getActiveSession() or SparkSession.builder.getOrCreate()
            except Exception as e:  # pragma: no cover - runtime dependent
                raise RuntimeError(
                    "No Spark session available. Run inside Databricks or pass spark=…"
                ) from e
        return self._spark

    # --- registry ---
    def load_registry(self) -> list[dict[str, Any]]:
        table = self.source.backend.registry_table
        if not table:
            raise ValueError("backend.registry_table is not set for this GraphSource")
        df = self.spark.sql(
            f"""
            SELECT ontology_uri, ontology_label, entity_type, uc_table, uc_column,
                   join_key, data_type, search_aliases, is_filterable, is_aggregatable
            FROM {table}
            ORDER BY uc_table, entity_type DESC
            """
        )
        return [row.asDict() for row in df.collect()]

    # --- sql ---
    def execute_sql(self, sql: str, limit: int) -> dict[str, Any]:
        df = self.spark.sql(sql)
        rows = [r.asDict() for r in df.limit(limit).collect()]
        return {
            "columns": df.columns,
            "rows": rows,
            "row_count": df.count(),
        }

    # --- vector search ---
    def _get_index(self):
        if self._vs_index is None:
            from databricks.vector_search.client import VectorSearchClient

            client = VectorSearchClient()
            self._vs_index = client.get_index(
                endpoint_name=self.source.backend.vector_endpoint,
                index_name=self.source.backend.vector_index,
            )
        return self._vs_index

    def vector_search(
        self, query: str, num_results: int, filters: Optional[dict] = None
    ) -> list[dict[str, Any]]:
        if not self.source.backend.vector_index:
            return []
        try:
            index = self._get_index()
            columns = ["chunk_text", "file_name", "contract_type", "region", "business_unit"]
            kwargs = {"query_text": query, "columns": columns, "num_results": num_results}
            if filters:
                kwargs["filters"] = filters
            res = index.similarity_search(**kwargs)
            data = res.get("result", {}).get("data_array", [])
            col_names = [c["name"] for c in res.get("manifest", {}).get("columns", [])]
            return [dict(zip(col_names, row)) for row in data]
        except Exception as e:  # pragma: no cover - runtime dependent
            print(f"[DatabricksUCAdapter] vector_search unavailable: {e}")
            return []


def make_adapter(source: GraphSource, spark: Any = None) -> BackendAdapter:
    """Factory: pick the adapter implementation from the descriptor backend type."""
    btype = source.backend.type
    if btype == "databricks-uc":
        return DatabricksUCAdapter(source, spark=spark)
    raise NotImplementedError(
        f"Backend '{btype}' not implemented yet. The adapter seam is ready — "
        f"add a BackendAdapter subclass and register it in make_adapter()."
    )
