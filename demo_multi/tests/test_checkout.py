from shop.cart import Cart
from shop.discount import coupon_off_cents


def test_unknown_sku_raises():
    cart = Cart()
    try:
        cart.add("NOPE")
    except KeyError:
        return
    raise AssertionError("unknown sku should raise KeyError")


def test_subtotal_two_items():
    cart = Cart()
    cart.add("A100", 1)
    cart.add("B200", 2)
    assert cart.subtotal_cents() == 14000


def test_coupon_tiers():
    assert coupon_off_cents(4999) == 0
    assert coupon_off_cents(5000) == 500
    assert coupon_off_cents(10000) == 1500
    assert coupon_off_cents(14000) == 1500


def test_checkout_total():
    cart = Cart()
    cart.add("A100")
    cart.add("B200", 2)
    assert cart.total_cents() == 12500
