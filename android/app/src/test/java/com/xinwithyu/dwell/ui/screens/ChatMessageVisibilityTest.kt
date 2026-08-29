package com.xinwithyu.dwell.ui.screens

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatMessageVisibilityTest {
    @Test
    fun rawToolMessagesAreNeverMobileVisible() {
        assertFalse(isMobileVisibleMessageKind("tool"))
        assertTrue(isMobileVisibleMessageKind("me"))
        assertTrue(isMobileVisibleMessageKind("gu"))
        assertTrue(isMobileVisibleMessageKind("think"))
    }
}
