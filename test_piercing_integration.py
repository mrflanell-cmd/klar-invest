import unittest
from app import detect

def bar(date, o, h, l, c):
    return {"date":date,"open":o,"high":h,"low":l,"close":c}

class PiercingIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.a=bar("2026-11-02",100,102,89,90)
        self.c=bar("2026-11-04",100,105,99,101)
    def test_classic(self):
        r=detect([self.a,bar("2026-11-03",89,98,87,96),self.c],"piercing",0,1000)
        self.assertEqual(r["variant"],"classic")
        self.assertEqual((r["entry"],r["stop"]),(100,87))
    def test_mild(self):
        r=detect([self.a,bar("2026-11-03",89,95,87,92),self.c],"piercing",0,1000)
        self.assertEqual(r["variant"],"mild")
        self.assertIsNone(detect([self.a,bar("2026-11-03",89,95,87,92),self.c],"piercing_classic",0,1000))
    def test_no_confirmation(self):
        self.assertIsNone(detect([self.a,bar("2026-11-03",89,98,87,96),bar("2026-11-04",99,101,95,100)],"piercing",0,1000))
    def test_no_lower_wick_needed(self):
        self.assertIsNotNone(detect([self.a,bar("2026-11-03",89,98,89,96),self.c],"piercing",0,1000))
    def test_midpoint_boundary_is_mild(self):
        r=detect([self.a,bar("2026-11-03",89,95,87,95),self.c],"piercing",0,1000)
        self.assertEqual(r["variant"],"mild")

if __name__=="__main__":
    unittest.main()
