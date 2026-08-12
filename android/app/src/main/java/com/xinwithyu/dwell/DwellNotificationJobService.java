package com.xinwithyu.dwell;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

public final class DwellNotificationJobService extends JobService {
    static final String PREFS = "dwell-native";
    static final String KEY_ENABLED = "notifications-enabled";
    static final String KEY_ENDPOINT = "backend-endpoint";
    static final String KEY_TOKEN = "backend-token";
    static final String KEY_LAST_SEQ = "notification-last-seq";
    static final String KEY_LAST_ATTEMPT = "notification-last-attempt";
    static final String KEY_LAST_SUCCESS = "notification-last-success";
    static final String KEY_LAST_ERROR = "notification-last-error";
    static final String KEY_LAST_STATUS = "notification-last-status";
    static final String KEY_LAST_COUNT = "notification-last-count";
    static final String EXTRA_ROUTE = "dwell-notification-route";

    private static final int JOB_ID = 0x4457454C;
    private static final int JOB_NOW_ID = JOB_ID + 1;
    private static final String CHANNEL_ID = "dwell-messages";
    private static final Object POLL_LOCK = new Object();
    private final ConcurrentHashMap<Integer, AtomicBoolean> cancellations = new ConcurrentHashMap<>();

    static void schedule(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_ENABLED, false) || prefs.getString(KEY_ENDPOINT, "").isEmpty()) return;
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) return;
        JobInfo info = new JobInfo.Builder(JOB_ID, new ComponentName(context, DwellNotificationJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .setPeriodic(15 * 60 * 1000L)
                .build();
        scheduler.schedule(info);
        pollNow(context);
    }

    static void pollNow(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_ENABLED, false) || prefs.getString(KEY_ENDPOINT, "").isEmpty()) return;
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) return;
        JobInfo immediate = new JobInfo.Builder(JOB_NOW_ID, new ComponentName(context, DwellNotificationJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setMinimumLatency(250L)
                .setOverrideDeadline(5000L)
                .build();
        scheduler.schedule(immediate);
    }

    static void cancel(Context context) {
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler != null) {
            scheduler.cancel(JOB_ID);
            scheduler.cancel(JOB_NOW_ID);
        }
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        int jobId = params.getJobId();
        AtomicBoolean signal = new AtomicBoolean(false);
        AtomicBoolean previous = cancellations.put(jobId, signal);
        if (previous != null) previous.set(true);
        new Thread(() -> {
            try {
                synchronized (POLL_LOCK) {
                    if (!signal.get()) poll(signal);
                }
            } catch (Exception error) {
                recordFailure(error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage()));
            } finally {
                if (cancellations.remove(jobId, signal) && !signal.get()) jobFinished(params, false);
            }
        }, "dwell-notifications").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        AtomicBoolean signal = cancellations.remove(params.getJobId());
        if (signal != null) signal.set(true);
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        return prefs.getBoolean(KEY_ENABLED, false)
                && !prefs.getString(KEY_ENDPOINT, "").isEmpty();
    }

    private void poll(AtomicBoolean signal) throws Exception {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        prefs.edit().putLong(KEY_LAST_ATTEMPT, System.currentTimeMillis()).putString(KEY_LAST_STATUS, "checking").apply();
        if (!prefs.getBoolean(KEY_ENABLED, false)) return;
        String endpoint = prefs.getString(KEY_ENDPOINT, "").replaceAll("/+$", "");
        String token = prefs.getString(KEY_TOKEN, "");
        long since = prefs.getLong(KEY_LAST_SEQ, 0L);
        if (endpoint.isEmpty() || signal.get()) return;

        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint + "/api/notifications?since=" + since).openConnection();
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(12000);
        connection.setRequestProperty("Accept", "application/json");
        if (!token.isEmpty()) connection.setRequestProperty("X-Dwell-Token", token);
        int code;
        String raw;
        try {
            code = connection.getResponseCode();
            InputStream stream = code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream();
            raw = stream == null ? "" : readAll(stream);
        } finally {
            connection.disconnect();
        }
        if (code < 200 || code >= 300) throw new IllegalStateException("HTTP " + code + (raw.isEmpty() ? "" : " · " + raw.substring(0, Math.min(160, raw.length()))));
        JSONObject data = new JSONObject(raw);
        if (!data.optBoolean("ok", false)) throw new IllegalStateException(data.optString("error", "notification response not ok"));
        long next = data.optLong("next", since);
        JSONArray items = data.optJSONArray("items");

        // The first successful poll establishes a baseline so enabling notifications
        // does not replay the user's old conversation as a burst of alerts.
        if (since > 0 && items != null && !signal.get()) {
            int start = Math.max(0, items.length() - 3);
            for (int i = start; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item != null) show(this, item.optString("title", "dwell"), item.optString("body", "有新消息"), item.optLong("id", System.currentTimeMillis()), item.optString("route", ""));
            }
        }
        prefs.edit()
                .putLong(KEY_LAST_SEQ, Math.max(since, next))
                .putLong(KEY_LAST_SUCCESS, System.currentTimeMillis())
                .putString(KEY_LAST_ERROR, "")
                .putString(KEY_LAST_STATUS, "ok")
                .putInt(KEY_LAST_COUNT, items == null ? 0 : items.length())
                .apply();
    }

    private void recordFailure(String detail) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString(KEY_LAST_STATUS, "error")
                .putString(KEY_LAST_ERROR, detail == null ? "unknown" : detail.substring(0, Math.min(500, detail.length())))
                .apply();
    }

    static JSONObject diagnostics(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONObject out = new JSONObject();
        try {
            boolean permission = Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
            JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            boolean periodic = false;
            boolean immediate = false;
            if (scheduler != null) {
                for (JobInfo job : scheduler.getAllPendingJobs()) {
                    if (job.getId() == JOB_ID) periodic = true;
                    if (job.getId() == JOB_NOW_ID) immediate = true;
                }
            }
            out.put("enabled", prefs.getBoolean(KEY_ENABLED, false));
            out.put("permission", permission);
            out.put("endpoint", !prefs.getString(KEY_ENDPOINT, "").isEmpty());
            out.put("periodic", periodic);
            out.put("immediate", immediate);
            out.put("lastAttempt", prefs.getLong(KEY_LAST_ATTEMPT, 0L));
            out.put("lastSuccess", prefs.getLong(KEY_LAST_SUCCESS, 0L));
            out.put("lastError", prefs.getString(KEY_LAST_ERROR, ""));
            out.put("lastStatus", prefs.getString(KEY_LAST_STATUS, "never"));
            out.put("lastCount", prefs.getInt(KEY_LAST_COUNT, 0));
        } catch (Exception ignored) {}
        return out;
    }

    private String readAll(InputStream stream) throws Exception {
        StringBuilder out = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null && out.length() < 512_000) out.append(line);
        }
        return out.toString();
    }

    static void show(Context context, String title, String body, long notificationId, String route) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "dwell 消息与任务", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Mac 上有新回复或定时任务完成时提醒");
        manager.createNotificationChannel(channel);
        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (route != null && !route.isEmpty()) open.putExtra(EXTRA_ROUTE, route);
        int requestCode = (int) (notificationId & 0x7fffffff);
        PendingIntent pending = PendingIntent.getActivity(context, requestCode, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        android.app.Notification.Builder builder = new android.app.Notification.Builder(context, CHANNEL_ID);
        builder.setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title == null || title.isEmpty() ? "dwell" : title)
                .setContentText(body == null || body.isEmpty() ? "有新消息" : body)
                .setStyle(new android.app.Notification.BigTextStyle().bigText(body == null || body.isEmpty() ? "有新消息" : body))
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setShowWhen(true);
        manager.notify((int) (notificationId & 0x7fffffff), builder.build());
    }
}
