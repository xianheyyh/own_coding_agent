from shop.cart import Cart
from shop.discount import coupon_off_cents
from shop.tax import tax_cents


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
    # 10000*1 + 2000*2 = 14000
    assert cart.subtotal_cents() == 14000


def test_coupon_tiers():
    assert coupon_off_cents(4999) == 0
    assert coupon_off_cents(5000) == 500
    assert coupon_off_cents(10000) == 1500
    assert coupon_off_cents(14000) == 1500


def test_add_over_stock_raises():
    cart = Cart()
    try:
        cart.add("B200", 3)
    except ValueError:
        return
    raise AssertionError("qty over stock should raise ValueError")


def test_add_up_to_stock():
    cart = Cart()
    cart.add("B200", 2)


def test_tax_six_percent():
    # 12500 * 6% = 750，向下取整
    assert tax_cents(12500) == 750
    assert tax_cents(0) == 0


def test_checkout_total():
    cart = Cart()
    cart.add("A100")
    cart.add("B200", 2)
    # 小计 14000 - 满100减15(1500) = 12500，再加 6% 税 750 = 13250
    assert cart.total_cents() == 13250
