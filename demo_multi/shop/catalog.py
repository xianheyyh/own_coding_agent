PRODUCTS = {
    "A100": {"name": "notebook", "price_cents": 10000},
    "B200": {"name": "mouse", "price_cents": 2000},
}


def get_product(sku: str) -> dict:
    if sku not in PRODUCTS:
        raise KeyError(sku)
    return PRODUCTS[sku]
