"""Lematizador con interfaz estable para el pipeline NLP.

Backend principal:
- spaCy==3.7.x
- Modelo recomendado para español: es_core_news_md==3.7.0

La carga del backend es *lazy*. Si spaCy/modelo no está disponible,
se aplica fallback seguro: lemma=token original y pos=None.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from functools import lru_cache
from typing import Iterable

PRIMARY_BACKEND = "spacy"
PRIMARY_BACKEND_VERSION = "3.7.x"
PRIMARY_MODEL = "es_core_news_md==3.7.0"
SUPPORTED_LANGS = {"es"}


@dataclass(frozen=True)
class LemmaItem:
    """Salida estructurada para cada token."""

    token: str
    lemma: str
    pos: str | None = None


@lru_cache(maxsize=1)
def _load_spanish_pipeline():
    """Carga el pipeline de spaCy para español.

    Returns:
        callable | None: función tipo nlp(text)->Doc, o None si no disponible.
    """

    try:
        import spacy  # type: ignore
    except Exception:
        return None

    for model_name in ("es_core_news_md", "es_core_news_sm"):
        try:
            return spacy.load(model_name)
        except Exception:
            continue
    return None


def _identity_fallback(tokens: Iterable[str]) -> list[LemmaItem]:
    return [LemmaItem(token=t, lemma=t, pos=None) for t in tokens]


def lemmatize(tokens: list[str], lang: str = "es") -> list[dict[str, str | None]]:
    """Lematiza una secuencia de tokens.

    Args:
        tokens: Lista de tokens presegmentados.
        lang: Idioma (actualmente soporte explícito para "es").

    Returns:
        Lista de objetos serializables con campos:
        - token (original)
        - lemma
        - pos (si backend lo provee)
    """

    if lang not in SUPPORTED_LANGS:
        return [asdict(item) for item in _identity_fallback(tokens)]

    nlp = _load_spanish_pipeline()
    if nlp is None:
        return [asdict(item) for item in _identity_fallback(tokens)]

    # Preserva alineación 1:1 con la entrada; evita retokenización de spaCy.
    doc = nlp.make_doc(" ".join(tokens))
    for _, proc in nlp.pipeline:
        doc = proc(doc)

    if len(doc) != len(tokens):
        return [asdict(item) for item in _identity_fallback(tokens)]

    items: list[LemmaItem] = []
    for original, analyzed in zip(tokens, doc):
        lemma = analyzed.lemma_ or original
        pos = analyzed.pos_ or None
        items.append(LemmaItem(token=original, lemma=lemma, pos=pos))

    return [asdict(item) for item in items]
