package nl.thepuppet.dexart;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Asks once for the address of your Dex Art Tracker server and remembers it. */
public class SetupActivity extends Activity {
    static final String PREFS = "dex";
    static final String KEY_SERVER = "server";

    private EditText input;
    private TextView message;

    /** "dex.example.com", "https://dex.example.com/view/" -> "https://dex.example.com" (null when unusable). */
    static String cleanServer(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty()) return null;
        if (!s.matches("(?i)^https?://.*")) s = "https://" + s;
        s = s.replaceAll("/+$", "");
        s = s.replaceAll("(?i)/view$", "");
        s = s.replaceAll("/+$", "");
        android.net.Uri u = android.net.Uri.parse(s);
        if (u.getHost() == null || u.getHost().isEmpty() || u.getHost().contains(" ")) return null;
        return s;
    }

    static String savedServer(Activity a) {
        return a.getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER, null);
    }

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.parseColor("#10131a"));
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(48), dp(24), dp(24));
        scroll.addView(box);

        TextView title = new TextView(this);
        title.setText("DEX ART TRACKER");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setLetterSpacing(0.12f);
        box.addView(title);

        TextView help = new TextView(this);
        help.setText("Enter the address of your Dex Art Tracker server, for example dex.example.com. "
                + "The app opens its /view/ page: log in to your own dex with the blue lens there. "
                + "Use the https address (your reverse proxy) so the camera can scan cards.");
        help.setTextColor(Color.parseColor("#8fa6c0"));
        help.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        help.setPadding(0, dp(14), 0, dp(18));
        box.addView(help);

        input = new EditText(this);
        input.setHint("https://dex.example.com");
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        input.setTextColor(Color.parseColor("#b9ffdc"));
        input.setHintTextColor(Color.parseColor("#5d728a"));
        input.setPadding(dp(14), dp(12), dp(14), dp(12));
        GradientDrawable field = new GradientDrawable();
        field.setColor(Color.parseColor("#0b1f2e"));
        field.setCornerRadius(dp(10));
        field.setStroke(dp(1), Color.parseColor("#2c3a54"));
        input.setBackground(field);
        String current = savedServer(this);
        if (current != null) input.setText(current);
        input.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override public boolean onEditorAction(TextView v, int actionId, KeyEvent event) { save(); return true; }
        });
        box.addView(input);

        Button go = new Button(this);
        go.setText("Open");
        go.setTextColor(Color.WHITE);
        GradientDrawable btn = new GradientDrawable();
        btn.setColor(Color.parseColor("#d4202f"));
        btn.setCornerRadius(dp(24));
        go.setBackground(btn);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(50));
        lp.topMargin = dp(16);
        go.setLayoutParams(lp);
        go.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { save(); }
        });
        box.addView(go);

        message = new TextView(this);
        message.setTextColor(Color.parseColor("#ff4d63"));
        message.setPadding(0, dp(12), 0, 0);
        message.setGravity(Gravity.START);
        box.addView(message);

        setContentView(scroll);
    }

    private void save() {
        String s = cleanServer(input.getText().toString());
        if (s == null) { message.setText("That does not look like a server address."); return; }
        SharedPreferences.Editor e = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        e.putString(KEY_SERVER, s);
        e.apply();
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        i.putExtra("reload", true);
        startActivity(i);
        finish();
    }
}
