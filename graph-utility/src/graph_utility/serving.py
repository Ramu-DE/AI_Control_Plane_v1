"""MLflow pyfunc wrapper — deploy the generic OMDA engine to Databricks Model Serving.

This is the QUERY-PLANE packaging. One serving endpoint can host one or many
GraphSources: the request carries `graph_source_id`, and the model resolves the
right descriptor + engine instance (cached). This keeps the engine generic and
multi-BU — AgentControl just points the selected dataset at this endpoint.

Request schema (model_input, a pandas DataFrame or list of dicts):
    [{"graph_source_id": "contract-iq",
      "question": "therapeutic area for contracts with supplier IQVIA",
      "limit": 50, "dry_run": false}]

Response: list[str] of JSON blobs (one per input row) with sql/concepts/rows.

Deploy (run from a Databricks notebook where graph_sources/ is accessible):
    import mlflow
    from graph_utility.serving import OMDAServingModel
    with mlflow.start_run():
        mlflow.pyfunc.log_model(
            artifact_path="omda",
            python_model=OMDAServingModel(),
            artifacts={"graph_sources": "/dbfs/…/graph_sources"},
            pip_requirements=["mlflow", "pandas"],  # + pyspark provided by runtime
            registered_model_name="graph_utility_omda",
        )
    # then create a Model Serving endpoint from the registered model.

Heavy deps (mlflow, pandas, pyspark, boto3) are imported lazily so this module
imports cleanly anywhere for inspection/testing.
"""
from __future__ import annotations

import json
import os
from typing import Any

try:  # mlflow is only present in the serving/deploy environment
    import mlflow.pyfunc as _pyfunc
    _Base = _pyfunc.PythonModel
except Exception:  # pragma: no cover - keep importable without mlflow
    class _Base:  # minimal stand-in so the class body is valid
        pass


class OMDAServingModel(_Base):
    """pyfunc model that routes each request to the right GraphSource engine.

    - load_context: load all GraphSource descriptors from the packaged
      `graph_sources` artifact directory into a registry.
    - predict: per row, resolve graph_source_id -> engine (cached) -> answer.

    An optional LLM callable can be wired for concept-extraction fallback; by
    default keyword extraction (grounded in the registry) is used.
    """

    def __init__(self, llm_fn=None) -> None:
        self._registry = None
        self._engines: dict[str, Any] = {}
        self._llm_fn = llm_fn

    # ------------------------------------------------------------------ #
    def load_context(self, context) -> None:  # noqa: D401
        from graph_utility.descriptor import GraphSourceRegistry

        gs_dir = None
        if context is not None and getattr(context, "artifacts", None):
            gs_dir = context.artifacts.get("graph_sources")
        gs_dir = gs_dir or os.environ.get("GRAPH_SOURCES_DIR", "graph_sources")
        self._registry = GraphSourceRegistry.from_dir(gs_dir)

    # ------------------------------------------------------------------ #
    def _engine_for(self, graph_source_id: str):
        if graph_source_id in self._engines:
            return self._engines[graph_source_id]
        from graph_utility.backends import make_adapter
        from graph_utility.engine import OMDAEngine

        source = self._registry.get(graph_source_id)
        adapter = make_adapter(source)  # resolves Spark lazily on first query
        engine = OMDAEngine(source, adapter, llm_fn=self._llm_fn)
        self._engines[graph_source_id] = engine
        return engine

    # ------------------------------------------------------------------ #
    @staticmethod
    def _rows(model_input) -> list[dict[str, Any]]:
        # Accept a pandas DataFrame or a list of dicts.
        if hasattr(model_input, "to_dict"):
            return model_input.to_dict(orient="records")
        if isinstance(model_input, dict):
            return [model_input]
        return list(model_input)

    def predict(self, context, model_input) -> list[str]:
        if self._registry is None:
            # Allow direct use in tests without an MLflow context.
            self.load_context(context)

        results: list[str] = []
        for row in self._rows(model_input):
            gsid = row.get("graph_source_id")
            question = row.get("question", "")
            limit = int(row.get("limit", 50))
            dry_run = bool(row.get("dry_run", False))
            try:
                engine = self._engine_for(gsid)
                out = engine.answer(question, limit=limit, dry_run=dry_run)
            except Exception as e:
                out = {"graph_source_id": gsid, "question": question, "error": str(e)}
            results.append(json.dumps(out, default=str))
        return results
