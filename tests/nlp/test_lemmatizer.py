from src.nlp import lemmatizer


class FakeToken:
    def __init__(self, text: str, lemma: str, pos: str):
        self.text = text
        self.lemma_ = lemma
        self.pos_ = pos


class FakeNLP:
    def __init__(self, mapping):
        self.mapping = mapping
        self.pipeline = [("dummy", self._noop)]

    def _noop(self, doc):
        return doc

    def make_doc(self, text):
        tokens = text.split(" ")
        return [
            FakeToken(tok, *self.mapping.get(tok, (tok, "X")))
            for tok in tokens
        ]


def test_fallback_when_model_is_unavailable(monkeypatch):
    monkeypatch.setattr(lemmatizer, "_load_spanish_pipeline", lambda: None)

    tokens = ["procesos", "primarios"]
    result = lemmatizer.lemmatize(tokens, lang="es")

    assert result == [
        {"token": "procesos", "lemma": "procesos", "pos": None},
        {"token": "primarios", "lemma": "primarios", "pos": None},
    ]


def test_structured_output_with_domain_sentences(monkeypatch):
    fake_mapping = {
        "procesos": ("proceso", "NOUN"),
        "primarios": ("primario", "ADJ"),
        "contrataciones": ("contratación", "NOUN"),
        "dirigen": ("dirigir", "VERB"),
        "la": ("el", "DET"),
        "organización": ("organización", "NOUN"),
    }
    monkeypatch.setattr(
        lemmatizer,
        "_load_spanish_pipeline",
        lambda: FakeNLP(fake_mapping),
    )

    tokens = [
        "procesos",
        "primarios",
        "contrataciones",
        "dirigen",
        "la",
        "organización",
    ]

    result = lemmatizer.lemmatize(tokens, lang="es")

    assert result == [
        {"token": "procesos", "lemma": "proceso", "pos": "NOUN"},
        {"token": "primarios", "lemma": "primario", "pos": "ADJ"},
        {"token": "contrataciones", "lemma": "contratación", "pos": "NOUN"},
        {"token": "dirigen", "lemma": "dirigir", "pos": "VERB"},
        {"token": "la", "lemma": "el", "pos": "DET"},
        {"token": "organización", "lemma": "organización", "pos": "NOUN"},
    ]


def test_unknown_language_uses_identity_fallback():
    tokens = ["workers", "hiring"]
    result = lemmatizer.lemmatize(tokens, lang="en")

    assert result == [
        {"token": "workers", "lemma": "workers", "pos": None},
        {"token": "hiring", "lemma": "hiring", "pos": None},
    ]
