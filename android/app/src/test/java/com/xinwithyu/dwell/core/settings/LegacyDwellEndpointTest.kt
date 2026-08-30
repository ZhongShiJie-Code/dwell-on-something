package com.xinwithyu.dwell.core.settings

import org.junit.Assert.assertEquals
import org.junit.Test

class LegacyDwellEndpointTest {
    @Test
    fun upgradesTheRetiredDwellBackendPort() {
        assertEquals(
            "http://192.168.1.8:8788",
            migrateLegacyDwellLocalUrl("http://192.168.1.8:18787"),
        )
    }

    @Test
    fun keepsCurrentAndRemoteUrlsUnchanged() {
        assertEquals(
            "https://dwell.example.test",
            migrateLegacyDwellLocalUrl("https://dwell.example.test/"),
        )
        assertEquals(
            "http://192.168.1.8:8788",
            migrateLegacyDwellLocalUrl("http://192.168.1.8:8788"),
        )
    }
}
